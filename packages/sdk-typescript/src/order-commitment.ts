/**
 * The caller's own copy of the canonical order id, and the budget it commits.
 *
 * Nothing here goes on the wire. `OrderAuthorization` — and
 * `SendOrderRequest.authorization` with it — was deleted: the arborter derives
 * the order id itself from the signed `Order` and a caller cannot choose one.
 * What this module produces is the client's copy, for recognising a fill it has
 * not yet seen an id for, and (on the FCE transport) for the `orderId` key the
 * ext-proxy adapter's JSON still declares.
 *
 * # Parity is the whole contract, and it fails silently
 *
 * The arborter runs the same recipe over the message it verified
 * (`app/server/src/handlers/order_id.rs`); the Rust SDK runs it as
 * `aspens::commands::trading::gasless::build_order_commitment`. If the recipes
 * drift **nothing errors** — the ids simply differ. Four inputs are easy to get
 * wrong and each is pinned by a test below:
 *
 *   1. **Token identifiers are hashed as their ADDRESS STRINGS**, UTF-8 bytes of
 *      the text, NOT the decoded address. `"0xAb…"` and `"0xab…"` are therefore
 *      different preimages, so the strings are taken verbatim from `market.id`
 *      — the exact substrings the arborter cuts and hashes — and never
 *      lower-cased, checksummed or decoded on the way.
 *   2. **The user address IS decoded**, in its chain's own form: 20 raw bytes
 *      for EVM (hex), 32 for Solana (base58). Case is irrelevant there, so an
 *      EIP-55 spelling and a lowercase one are the same order.
 *   3. **Amounts are in each token's NATIVE base units**, not the market's pair
 *      units. `quantity` / `price` arrive in pair units (what the matching
 *      engine walks in and what the caller signed) and are restated here;
 *      `quantity × price` carries `2 × pairDecimals`, which is where the two
 *      quote-side conversions start. A market bid's `quoteBudget` is ALREADY in
 *      quote-token units and is taken verbatim — re-scaling it is a bug that
 *      has shipped before.
 *   4. **A market order's expected output is zero**, on both sides. With no
 *      price there is no honest expectation, and zero is how "unknown at
 *      signing time" is encoded. A convention, so it is pinned rather than
 *      left implicit.
 */

import { PublicKey } from "@solana/web3.js";

import { deriveOrderId } from "./gasless.js";
import type { Configuration } from "./protos/arborter_config_pb.js";
import type { Market } from "./types.js";

/** Largest value a `uint64` can carry — the nonce's ceiling. */
const U64_MAX = (1n << 64n) - 1n;

/**
 * A fresh client nonce: unix milliseconds.
 *
 * Mirrors the Rust SDK's `client_nonce()`. Millis is a choice, not a
 * requirement — any `uint64` works, and reusing one deliberately is how a
 * caller asks for a replay to be refused (the repeat derives the same id).
 *
 * Mint it ONCE per order and pass the same value to `OrderSigningData.nonce`,
 * {@link buildOrderCommitment} and `PlaceOrderParams.nonce`.
 */
export function clientNonce(): bigint {
  const ms = BigInt(Date.now());
  if (ms < 0n || ms > U64_MAX) {
    throw new Error(`unix millis ${ms} is not a uint64`);
  }
  return ms;
}

/** What {@link buildOrderCommitment} produces. None of it is sent over gRPC. */
export interface OrderCommitment {
  /**
   * The canonical 32-byte order id, `0x`-prefixed lowercase hex — the same
   * value the arborter derives from the signed `Order`, provided `nonce` is the
   * one that order carries.
   */
  orderId: string;
  /**
   * The order's budget — how much of the asset it GIVES it commits — in that
   * token's native base units (quote for a bid, base for an ask; for a market
   * bid the stated `quoteBudget` verbatim).
   */
  inputAmount: bigint;
  /** The nonce hashed into `orderId`. Must equal `Order.nonce`. */
  nonce: bigint;
}

export interface BuildOrderCommitmentOpts {
  /** Market the order is placed on. `market.id` supplies the token strings. */
  market: Market;
  /** Current `Configuration` — `client.cache.getConfig()`. Supplies chain ids. */
  config: Configuration;
  /** "buy" locks on the quote chain; "sell" locks on the base chain. */
  side: "buy" | "sell";
  /**
   * Address the order is SIGNED with — the arborter hashes the address its
   * signature verified against, which for a bid is `quote_account_address` and
   * for an ask `base_account_address`.
   */
  userAddress: string;
  /** `Order.quantity`: a pair-decimal-scaled integer string. */
  quantityRaw: string;
  /** `Order.price`: pair-decimal-scaled. Omit for a market order. */
  priceRaw?: string;
  /**
   * `Order.quote_budget`: the market BID's budget in the QUOTE token's native
   * base units. Required for a market bid, rejected on every other cell — the
   * same rule the arborter enforces.
   */
  quoteBudgetRaw?: string;
  /** The nonce carried by the `Order` being signed. */
  nonce: bigint;
}

/**
 * Derive the canonical order id for an order, and the budget it commits.
 *
 * `nonce` is a parameter rather than minted here precisely because the value
 * must also be set as `Order.nonce`; minting it internally would give the
 * caller no way to sign the same one.
 */
export function buildOrderCommitment(
  opts: BuildOrderCommitmentOpts,
): OrderCommitment {
  const { market, config, side, nonce } = opts;

  if (nonce < 0n || nonce > U64_MAX) {
    throw new Error(`nonce ${nonce} is not a uint64`);
  }

  const [baseNetwork, baseTokenAddress, quoteNetwork, quoteTokenAddress] =
    parseMarketId(market.id);

  // A bid gives quote and receives base; an ask the reverse. The same
  // orientation the arborter uses, and swapping it silently produces a
  // different id for every order on the market.
  const buy = side === "buy";
  const originNetwork = buy ? quoteNetwork : baseNetwork;
  const destinationNetwork = buy ? baseNetwork : quoteNetwork;
  const inputToken = buy ? quoteTokenAddress : baseTokenAddress;
  const outputToken = buy ? baseTokenAddress : quoteTokenAddress;

  const originChain = requireChain(config, originNetwork);
  const destinationChain = requireChain(config, destinationNetwork);

  const amounts = orderAmounts(opts, market);

  const orderIdBytes = deriveOrderId({
    userPubkey: userAddressBytes(opts.userAddress, originChain.architecture),
    clientNonce: nonce,
    originChainId: BigInt(originChain.chainId),
    destinationChainId: BigInt(destinationChain.chainId),
    // UTF-8 of the address TEXT. Not decoded, not re-cased — see the header.
    inputToken: new TextEncoder().encode(inputToken),
    outputToken: new TextEncoder().encode(outputToken),
    inputAmount: amounts.input,
    outputAmount: amounts.output,
  });

  return {
    orderId: `0x${Array.from(orderIdBytes, (b) => b.toString(16).padStart(2, "0")).join("")}`,
    inputAmount: amounts.input,
    nonce,
  };
}

// -- internals -----------------------------------------------------------

/**
 * `base_network::base_token::quote_network::quote_token`, the format the
 * arborter's own `parse_market_id` reads. Any trailing segments are ignored,
 * as they are there.
 */
function parseMarketId(marketId: string): [string, string, string, string] {
  const parts = marketId.split("::");
  if (parts.length < 4) {
    throw new Error(
      `market id '${marketId}' is not base_network::token::quote_network::token`,
    );
  }
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

type ConfigChain = Configuration["chains"][number];

function requireChain(config: Configuration, network: string): ConfigChain {
  const chain = config.chains.find((c) => c.network === network);
  if (!chain) {
    throw new Error(
      `chain '${network}' not found in arborter configuration — its chain id goes into the order id, so there is nothing to fall back to`,
    );
  }
  return chain;
}

/**
 * The raw bytes of a user address, in the form its chain hashes: 20 for EVM
 * (the hex decoded), 32 for Solana (the base58 pubkey). The curve — that is,
 * the chain's architecture — decides, not the string: `"111…1"` is both valid
 * base58 and valid hex and decodes to different bytes each way.
 */
function userAddressBytes(address: string, architecture: string): Uint8Array {
  if (/^solana$/i.test(architecture)) {
    return new PublicKey(address).toBytes();
  }
  const body = address.startsWith("0x") ? address.slice(2) : address;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(
      `account address '${address}' is not hex and so cannot be an EVM address`,
    );
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Restate an integer expressed in `from` decimals as one in `to` decimals.
 * Floors when scaling down — the same truncation the arborter and the Rust SDK
 * apply, so the committed budget is never larger than the order was sized for.
 */
function normalize(amount: bigint, from: number, to: number): bigint {
  if (from === to) return amount;
  return from > to
    ? amount / 10n ** BigInt(from - to)
    : amount * 10n ** BigInt(to - from);
}

/**
 * The `(input, output)` amounts, in native token units — one row per cell of
 * the order table. Mirrors the arborter's `order_amounts`.
 *
 * | cell       | input                       | output                      |
 * |------------|-----------------------------|-----------------------------|
 * | limit BID  | `qty × price` → quote units | `qty` → base units          |
 * | market BID | the stated budget, verbatim | `0`                         |
 * | limit ASK  | `qty` → base units          | `qty × price` → quote units |
 * | market ASK | `qty` → base units          | `0`                         |
 */
function orderAmounts(
  opts: BuildOrderCommitmentOpts,
  market: Market,
): { input: bigint; output: bigint } {
  const pairDecimals = market.pairDecimals;
  const baseDecimals = market.baseChainTokenDecimals;
  const quoteDecimals = market.quoteChainTokenDecimals;
  if (
    pairDecimals === undefined ||
    baseDecimals === undefined ||
    quoteDecimals === undefined
  ) {
    throw new Error(
      `market '${market.id}' is missing pair/base/quote decimals — every amount in the order id is scaled through them, and a default would hash a number nobody has`,
    );
  }

  const buy = opts.side === "buy";
  const isMarket = opts.priceRaw === undefined;

  // The arborter enforces exactly this rule (`quote_budget_for_cell`); saying
  // so here turns a server refusal into a local one.
  if (isMarket && buy) {
    if (opts.quoteBudgetRaw === undefined) {
      throw new Error(
        "a market bid must state its quote budget (Order.quote_budget) — nothing derivable bounds it",
      );
    }
  } else if (opts.quoteBudgetRaw !== undefined) {
    throw new Error(
      "quote_budget is only valid on a market bid; every other cell derives its budget from the order",
    );
  }

  const quantity = BigInt(opts.quantityRaw);
  const baseSide = () => normalize(quantity, pairDecimals, baseDecimals);
  const quoteSide = () =>
    normalize(
      quantity * BigInt(opts.priceRaw!),
      pairDecimals * 2,
      quoteDecimals,
    );

  if (buy) {
    return isMarket
      ? // Already in the quote token's own units — taken verbatim, never
        // re-scaled.
        { input: BigInt(opts.quoteBudgetRaw!), output: 0n }
      : { input: quoteSide(), output: baseSide() };
  }
  return isMarket
    ? { input: baseSide(), output: 0n }
    : { input: baseSide(), output: quoteSide() };
}
