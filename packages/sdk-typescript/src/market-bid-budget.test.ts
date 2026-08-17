/**
 * `marketBidQuoteBudget` — the pair-decimals → quote-token-decimals boundary.
 *
 * A market bid is the one order whose budget the arborter does NOT derive: it
 * reserves the caller's `quote_budget` verbatim, in the quote token's own base
 * units. The matching engine, meanwhile, works in pair decimals. A budget at
 * the wrong scale is accepted and mis-collateralised rather than rejected, so
 * every case below uses a market where the two scales DIFFER — equal decimals
 * would pass whether or not the conversion happens at all.
 */

import { describe, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { marketBidQuoteBudget } from "./decimals.js";
import { OrderSchema } from "./protos/arborter_pb.js";
import { createOrderMessage, type OrderSigningData } from "./signing.js";

const pow = (n: number) => 10n ** BigInt(n);

describe("marketBidQuoteBudget", () => {
  test("scales DOWN from pair decimals to a coarser quote token (18 → 6)", () => {
    // 2 base at a 1.5 reference price = 3 quote. On a USDC-quoted market that
    // is 3_000_000, not 3e18 — the unconverted figure is a trillion times the
    // intended spend.
    const budget = marketBidQuoteBudget({
      sizeRaw: (2n * pow(18)).toString(),
      referencePriceRaw: (15n * pow(17)).toString(),
      pairDecimals: 18,
      quoteTokenDecimals: 6,
    });
    expect(budget).toBe(3_000_000n);
  });

  test("scales UP from pair decimals to a finer quote token (6 → 18)", () => {
    const budget = marketBidQuoteBudget({
      sizeRaw: (2n * pow(6)).toString(),
      referencePriceRaw: (15n * pow(5)).toString(),
      pairDecimals: 6,
      quoteTokenDecimals: 18,
    });
    expect(budget).toBe(3n * pow(18));
  });

  test("floors rather than rounding up — the budget is never larger than the spend it was sized to", () => {
    // 1.0000005 quote in pair units (18dp) against a 6dp token: the trailing
    // half-unit cannot be represented and must be dropped, not rounded up.
    const budget = marketBidQuoteBudget({
      sizeRaw: pow(18).toString(), // 1 base
      referencePriceRaw: (pow(18) + 5n * pow(11)).toString(),
      pairDecimals: 18,
      quoteTokenDecimals: 6,
    });
    expect(budget).toBe(1_000_000n);
  });

  test("returns 0n when the budget floors away below the quote token's precision", () => {
    const budget = marketBidQuoteBudget({
      sizeRaw: "1000", // 1e-15 base at 18 pair decimals
      referencePriceRaw: pow(18).toString(),
      pairDecimals: 18,
      quoteTokenDecimals: 6,
    });
    expect(budget).toBe(0n);
  });

  test("returns 0n for a missing reference price or an empty size", () => {
    const common = { pairDecimals: 18, quoteTokenDecimals: 6 };
    expect(
      marketBidQuoteBudget({
        sizeRaw: (2n * pow(18)).toString(),
        referencePriceRaw: "0",
        ...common,
      }),
    ).toBe(0n);
    expect(
      marketBidQuoteBudget({
        sizeRaw: "0",
        referencePriceRaw: pow(18).toString(),
        ...common,
      }),
    ).toBe(0n);
  });

  test("stays exact past 2^53, where a float conversion would drift", () => {
    // 1e6 base at 1e6 quote-per-base on an 18dp pair / 18dp quote market.
    const budget = marketBidQuoteBudget({
      sizeRaw: (pow(6) * pow(18)).toString(),
      referencePriceRaw: (pow(6) * pow(18)).toString(),
      pairDecimals: 18,
      quoteTokenDecimals: 18,
    });
    expect(budget).toBe(pow(12) * pow(18));
  });
});

describe("quote_budget wire encoding", () => {
  const base: OrderSigningData = {
    side: "buy",
    quantity: "1000",
    marketId: "base::0xaa::quote::0xbb",
    baseAccountAddress: "0xb",
    quoteAccountAddress: "0xq",
  };

  test("omitted quoteBudget is wire-skipped (digests unchanged for the three derivable cells)", () => {
    const omitted = toBinary(OrderSchema, createOrderMessage({ ...base }));
    const explicitUndefined = toBinary(
      OrderSchema,
      createOrderMessage({ ...base, quoteBudget: undefined }),
    );
    expect(explicitUndefined).toEqual(omitted);
  });

  test("a market bid's quoteBudget reaches the signed bytes", () => {
    const plain = toBinary(OrderSchema, createOrderMessage({ ...base }));
    const budgeted = toBinary(
      OrderSchema,
      createOrderMessage({ ...base, quoteBudget: "3000000" }),
    );
    expect(budgeted).not.toEqual(plain);
    expect(budgeted.length).toBeGreaterThan(plain.length);
    // It is the ORDER that carries it, so the envelope signature — taken over
    // exactly these bytes — covers the number that authorises the spend.
    expect(new TextDecoder().decode(budgeted)).toContain("3000000");
  });
});
