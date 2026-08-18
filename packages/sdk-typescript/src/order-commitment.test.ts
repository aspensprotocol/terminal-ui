/**
 * Parity tests for the client's copy of the canonical order id.
 *
 * The arborter derives the id itself from the signed `Order`
 * (`app/server/src/handlers/order_id.rs`). If this recipe drifts from that one
 * **nothing errors** — the ids simply differ and the client tracks an order the
 * server never had. So the central test here is a KNOWN-GOOD VECTOR taken from
 * the arborter's own `sdk_parity_known_good_vector`, whose expected digest was
 * computed outside either codebase. Round-tripping this module against itself
 * would pin nothing.
 *
 * The fixture's three decimal scales are deliberately DISTINCT (pair 12, base
 * 18, quote 6). The integration harness's market has them all equal, which
 * collapses every denomination to the same integer and lets a wrong conversion
 * pass — the trap this suite exists to avoid.
 */

import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";

import {
  buildOrderCommitment,
  clientNonce,
  type BuildOrderCommitmentOpts,
} from "./order-commitment.js";
import {
  ConfigurationSchema,
  type Configuration,
} from "./protos/arborter_config_pb.js";
import type { Market } from "./types.js";

// -- fixture -------------------------------------------------------------

const PAIR = 12;
const BASE = 18;
const QUOTE = 6;

const BASE_NETWORK = "fixture-base";
const QUOTE_NETWORK = "fixture-quote";
const BASE_CHAIN_ID = 990_001;
const QUOTE_CHAIN_ID = 990_002;
const BASE_TOKEN = "0x00000000000000000000000000000000000000b1";
const QUOTE_TOKEN = "0x00000000000000000000000000000000000000c1";

/** EIP-55 checksummed — anvil account 0, as the arborter's vector uses it. */
const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const market: Market = {
  id: `${BASE_NETWORK}::${BASE_TOKEN}::${QUOTE_NETWORK}::${QUOTE_TOKEN}`,
  base_ticker: "BASE",
  quote_ticker: "QUOTE",
  tick_size: "1",
  lot_size: "1",
  min_size: "1",
  maker_fee_bps: 0,
  taker_fee_bps: 0,
  pairDecimals: PAIR,
  baseChainNetwork: BASE_NETWORK,
  quoteChainNetwork: QUOTE_NETWORK,
  baseChainTokenDecimals: BASE,
  quoteChainTokenDecimals: QUOTE,
};

const config: Configuration = create(ConfigurationSchema, {
  chains: [
    { network: BASE_NETWORK, chainId: BASE_CHAIN_ID, architecture: "EVM" },
    { network: QUOTE_NETWORK, chainId: QUOTE_CHAIN_ID, architecture: "EVM" },
  ],
});

/** 1.5 base at 2.0 quote-per-base, both in pair units (12 dp). */
const QUANTITY = "1500000000000";
const PRICE = "2000000000000";

function opts(
  over: Partial<BuildOrderCommitmentOpts> = {},
): BuildOrderCommitmentOpts {
  return {
    market,
    config,
    side: "buy",
    userAddress: USER,
    quantityRaw: QUANTITY,
    priceRaw: PRICE,
    nonce: 1_723_000_000_000n,
    ...over,
  };
}

// -- the premise the rest of the suite rests on --------------------------

describe("fixture", () => {
  test("the three decimal scales are mutually distinct", () => {
    // If these ever coincide, every amount assertion below stops
    // distinguishing a correct conversion from a wrong one.
    expect(PAIR).not.toBe(BASE);
    expect(PAIR).not.toBe(QUOTE);
    expect(BASE).not.toBe(QUOTE);
  });
});

// -- cross-implementation parity -----------------------------------------

describe("buildOrderCommitment", () => {
  test("matches the arborter's known-good vector for a limit bid", () => {
    // Copied verbatim from arborter
    // `app/server/src/handlers/order_id.rs::sdk_parity_known_good_vector`.
    // If this fails the wire contract broke: do NOT update the constant
    // without changing the arborter in the same breath.
    const commitment = buildOrderCommitment(opts());
    expect(commitment.orderId).toBe(
      "0xc6d8846de54b5b1b2513fa5fb8b535ea48bbe2835c17187e6564443aaa774f2d",
    );
  });

  test("a limit bid pays quote and receives base, each in its own units", () => {
    // 3.0 quote at 6 dp in, 1.5 base at 18 dp out — written out so a change in
    // the scaling is caught here and not only inside the digest.
    expect(buildOrderCommitment(opts()).inputAmount).toBe(3_000_000n);
    // The mirrored ask gives base and receives quote.
    expect(buildOrderCommitment(opts({ side: "sell" })).inputAmount).toBe(
      1_500_000_000_000_000_000n,
    );
  });

  test("a market bid's stated budget is taken verbatim, never re-scaled", () => {
    // 7.0 quote in the QUOTE token's own units. A recipe that re-scaled it
    // through pair decimals would commit 7e12 or 7e-6 of it instead.
    const commitment = buildOrderCommitment(
      opts({ priceRaw: undefined, quoteBudgetRaw: "7000000" }),
    );
    expect(commitment.inputAmount).toBe(7_000_000n);
  });

  test("the nonce is echoed back so the caller can bind it to Order.nonce", () => {
    expect(buildOrderCommitment(opts({ nonce: 42n })).nonce).toBe(42n);
  });
});

// -- what changes the id, and what must not ------------------------------

describe("order id inputs", () => {
  const id = () => buildOrderCommitment(opts()).orderId;

  test("the nonce changes the id — that is the replay control", () => {
    expect(
      buildOrderCommitment(opts({ nonce: 1_723_000_000_001n })).orderId,
    ).not.toBe(id());
  });

  test("a nonce above 2^53 survives exactly, not as a rounded double", () => {
    // 2^53 + 1 is the smallest integer a JS number cannot represent: anything
    // that routes the nonce through Number() lands on 2^53 and derives the
    // same id for both.
    const justOver = buildOrderCommitment(
      opts({ nonce: 9_007_199_254_740_993n }),
    ).orderId;
    const boundary = buildOrderCommitment(
      opts({ nonce: 9_007_199_254_740_992n }),
    ).orderId;
    expect(justOver).not.toBe(boundary);

    // And the full u64 range is reachable.
    expect(() =>
      buildOrderCommitment(opts({ nonce: (1n << 64n) - 1n })),
    ).not.toThrow();
    expect(() => buildOrderCommitment(opts({ nonce: 1n << 64n }))).toThrow();
  });

  test("side flips the id: a bid and an ask hash the trade from opposite ends", () => {
    expect(buildOrderCommitment(opts({ side: "sell" })).orderId).not.toBe(id());
  });

  test("the signer's address changes the id", () => {
    expect(
      buildOrderCommitment(
        opts({ userAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }),
      ).orderId,
    ).not.toBe(id());
  });

  test("the user address is DECODED, so its case is irrelevant", () => {
    // An EVM address is hex-decoded to 20 raw bytes, so an EIP-55 spelling and
    // an all-lowercase one are the same order.
    expect(
      buildOrderCommitment(opts({ userAddress: USER.toLowerCase() })).orderId,
    ).toBe(id());
  });

  test("a token address is hashed AS A STRING, so its case IS load-bearing", () => {
    // The arborter cuts these substrings out of `market_id` and hashes their
    // bytes without decoding. Re-casing an address anywhere on the order path
    // therefore changes the id — which is why nothing on this path does.
    const recased: Market = {
      ...market,
      id: `${BASE_NETWORK}::${BASE_TOKEN}::${QUOTE_NETWORK}::${QUOTE_TOKEN.toUpperCase().replace("0X", "0x")}`,
    };
    expect(buildOrderCommitment(opts({ market: recased })).orderId).not.toBe(
      id(),
    );
  });

  test("a market id that is not four segments is refused, not defaulted", () => {
    expect(() =>
      buildOrderCommitment(opts({ market: { ...market, id: "not-a-market" } })),
    ).toThrow(/base_network/);
  });

  test("an unregistered chain is refused, not hashed as zero", () => {
    // Zero is a perfectly hashable chain id that no other implementation ever
    // derives, so the lookup must fail loudly.
    expect(() =>
      buildOrderCommitment(
        opts({ config: create(ConfigurationSchema, { chains: [] }) }),
      ),
    ).toThrow(/not found in arborter configuration/);
  });

  test("a market missing its decimals is refused, not defaulted", () => {
    const { quoteChainTokenDecimals: _drop, ...missing } = market;
    expect(() =>
      buildOrderCommitment(opts({ market: missing as Market })),
    ).toThrow(/decimals/);
  });
});

// -- the budget rule, mirrored from the arborter -------------------------

describe("quote budget cell rule", () => {
  test("a market bid without a budget is refused here, not at the server", () => {
    expect(() => buildOrderCommitment(opts({ priceRaw: undefined }))).toThrow(
      /must state its quote budget/,
    );
  });

  test("a budget on any other cell is refused", () => {
    for (const cell of [
      { side: "buy" as const, priceRaw: PRICE },
      { side: "sell" as const, priceRaw: PRICE },
      { side: "sell" as const, priceRaw: undefined },
    ]) {
      expect(() =>
        buildOrderCommitment(opts({ ...cell, quoteBudgetRaw: "7000000" })),
      ).toThrow(/only valid on a market bid/);
    }
  });
});

// -- nonce minting -------------------------------------------------------

describe("clientNonce", () => {
  test("is unix millis and fits a uint64", () => {
    const before = BigInt(Date.now());
    const n = clientNonce();
    const after = BigInt(Date.now());
    expect(n).toBeGreaterThanOrEqual(before);
    expect(n).toBeLessThanOrEqual(after);
    expect(n).toBeLessThanOrEqual((1n << 64n) - 1n);
  });
});
