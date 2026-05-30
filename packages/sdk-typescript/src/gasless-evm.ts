/**
 * EVM order-authorization builder.
 *
 * Under the optimistic shadow ledger, order entry never touches the chain: the
 * arborter authenticates the order via the outer envelope signature and consumes
 * only `order_id` + `amount_in`. This builder resolves the order's chains /
 * tokens / amounts, derives the canonical 32-byte order id, and packs the
 * `OrderAuthorization`. No Permit2 lookup, no EIP-712 lock signature — those
 * were removed with the on-chain order machinery.
 */

import { create } from "@bufbuild/protobuf";
import { hexToBytes, type Address, type Hex } from "viem";

import { deriveOrderId } from "./gasless.js";
import {
  OrderAuthorizationSchema,
  type OrderAuthorization,
} from "./protos/arborter_pb.js";
import type { Configuration } from "./protos/arborter_config_pb.js";
import type { Market } from "./types.js";

export interface BuildEvmGaslessOpts {
  /** Market the order is being placed on. Must be an EVM-on-EVM market. */
  market: Market;
  /**
   * Current `Configuration` — pulled from `client.cache.getConfig()`.
   * Required because order-id derivation needs the origin/destination chain
   * ids + token addresses, which aren't on the Market itself.
   */
  config: Configuration;
  /** "buy" picks the quote chain as origin; "sell" picks the base chain. */
  side: "buy" | "sell";
  /** Input amount (on-origin-chain token) in raw base units. */
  amountIn: bigint;
  /** Output amount (on-destination-chain token) in raw base units. */
  amountOut: bigint;
  /** User's address on the origin chain (EVM hex). */
  userAddress: Address;
}

/**
 * Build an `OrderAuthorization` for an EVM-origin order. Also returns the
 * derived order id for logging / debugging.
 */
export async function buildEvmGaslessAuthorization(
  opts: BuildEvmGaslessOpts,
): Promise<{
  authorization: OrderAuthorization;
  orderId: Hex;
}> {
  const originChain = resolveOriginChain(opts.market, opts.config, opts.side);
  const destinationChain = resolveDestinationChain(
    opts.market,
    opts.config,
    opts.side,
  );

  const inputTokenAddress = requireToken(
    originChain,
    opts.side === "buy" ? opts.market.quote_ticker : opts.market.base_ticker,
  );
  const outputTokenAddress = requireToken(
    destinationChain,
    opts.side === "buy" ? opts.market.base_ticker : opts.market.quote_ticker,
  );

  const originChainId = BigInt(originChain.chainId);
  const destinationChainId = BigInt(destinationChain.chainId);

  // Client nonce: unix millis. Folded into the order id purely to keep it
  // unique across a wallet's orders — the arborter uses the id verbatim.
  const clientNonce = BigInt(Date.now());

  const orderIdBytes = deriveOrderId({
    userPubkey: hexToBytes(opts.userAddress),
    clientNonce,
    originChainId,
    destinationChainId,
    inputToken: hexToBytes(inputTokenAddress),
    outputToken: hexToBytes(outputTokenAddress),
    inputAmount: opts.amountIn,
    outputAmount: opts.amountOut,
  });
  const orderId = bytesToHexPrefixed(orderIdBytes);

  const authorization = create(OrderAuthorizationSchema, {
    orderId,
    amountIn: opts.amountIn.toString(),
  });

  return { authorization, orderId };
}

// -- Internal helpers ----------------------------------------------------

function resolveOriginChain(
  market: Market,
  config: Configuration,
  side: "buy" | "sell",
): ConfigChain {
  // Buy = spend quote, receive base → origin is the quote chain.
  // Sell = spend base, receive quote → origin is the base chain.
  const network =
    side === "buy" ? market.quoteChainNetwork : market.baseChainNetwork;
  if (!network) {
    throw new Error(
      `market '${market.id}' has no ${side === "buy" ? "quoteChainNetwork" : "baseChainNetwork"} — cannot build order authorization`,
    );
  }
  return requireChain(config, network);
}

function resolveDestinationChain(
  market: Market,
  config: Configuration,
  side: "buy" | "sell",
): ConfigChain {
  const network =
    side === "buy" ? market.baseChainNetwork : market.quoteChainNetwork;
  if (!network) {
    throw new Error(
      `market '${market.id}' has no ${side === "buy" ? "baseChainNetwork" : "quoteChainNetwork"} — cannot build order authorization`,
    );
  }
  return requireChain(config, network);
}

type ConfigChain = Configuration["chains"][number];

function requireChain(config: Configuration, network: string): ConfigChain {
  const chain = config.chains.find((c) => c.network === network);
  if (!chain) {
    throw new Error(
      `chain '${network}' not found in arborter configuration — cannot build order authorization`,
    );
  }
  return chain;
}

function requireToken(chain: ConfigChain, symbol: string): Address {
  const entry = chain.tokens[symbol];
  if (!entry) {
    throw new Error(
      `token '${symbol}' not configured on chain '${chain.network}'`,
    );
  }
  return entry.address as Address;
}

function bytesToHexPrefixed(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}
