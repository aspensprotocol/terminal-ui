/**
 * Redacted-fill behavior of the trade adapter.
 *
 * When a hidden order fills, arborter redacts that side's identity in
 * the public print: empty ids/addresses and orderHit = 0. The adapter
 * must (a) never let a redacted side borrow the visible side's address
 * via fallback chains — that misattributes the trade side in every
 * consumer comparing addresses — and (b) not collapse distinct redacted
 * fills onto one id (orderHit=0 made `${ts}-${orderHit}` collide).
 */

import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { TradeSchema } from "../protos/arborter_pb.js";
import { toEnhancedTrade, tradeKey } from "./trade-adapter.js";

/** Visible taker BUYS from a hidden (redacted) maker. */
function redactedMakerTrade(overrides: Record<string, unknown> = {}) {
  return create(TradeSchema, {
    timestamp: 1700000000000n,
    price: "50000000",
    qty: "1000000",
    makerBaseAddress: "", // redacted
    makerQuoteAddress: "", // redacted
    takerBaseAddress: "0xtaker",
    takerQuoteAddress: "0xtakerq",
    buyerIs: 2, // TAKER bought
    sellerIs: 1, // MAKER sold
    orderHit: new Uint8Array(32), // redacted
    ...overrides,
  });
}

describe("toEnhancedTrade with a redacted side", () => {
  test("redacted maker's address is NOT borrowed from the taker", () => {
    const t = toEnhancedTrade(redactedMakerTrade(), "m", 6);
    // Taker bought → buyer is the taker, seller is the (redacted) maker.
    expect(t.buyer_address).toBe("0xtaker");
    expect(t.seller_address).toBe(""); // stays empty — no fallback
  });

  test("maker-buys orientation maps addresses by role", () => {
    const t = toEnhancedTrade(
      redactedMakerTrade({ buyerIs: 1, sellerIs: 2 }), // MAKER bought
      "m",
      6,
    );
    expect(t.buyer_address).toBe(""); // redacted maker bought
    expect(t.seller_address).toBe("0xtaker");
  });

  test("two redacted fills with different price/qty get distinct ids", () => {
    const a = toEnhancedTrade(redactedMakerTrade(), "m", 6);
    const b = toEnhancedTrade(redactedMakerTrade({ qty: "2000000" }), "m", 6);
    expect(a.id).not.toBe(b.id);
  });
});

/** A fully visible print, every field distinct from every other. */
function visibleTrade(overrides: Record<string, unknown> = {}) {
  return create(TradeSchema, {
    timestamp: 1700000000123n,
    price: "50000001",
    qty: "1000002",
    makerBaseAddress: "0xmb",
    makerQuoteAddress: "0xmq",
    takerBaseAddress: "0xtb",
    takerQuoteAddress: "0xtq",
    buyerIs: 1,
    sellerIs: 2,
    orderHit: new Uint8Array(32).fill(0xcd),
    marketId: "net::0xb::net::0xq",
    ...overrides,
  });
}

describe("raw trade fields", () => {
  test("every field of the message is kept raw", () => {
    const t = toEnhancedTrade(visibleTrade(), "requested", 6);
    expect(t).toMatchObject({
      marketId: "net::0xb::net::0xq",
      timestampMs: 1700000000123n,
      priceRaw: "50000001",
      qtyRaw: "1000002",
      buyerIs: 1,
      sellerIs: 2,
      makerBaseAddress: "0xmb",
      makerQuoteAddress: "0xmq",
      takerBaseAddress: "0xtb",
      takerQuoteAddress: "0xtq",
      orderHit: `0x${"cd".repeat(32)}`,
    });
    // The display fields are untouched.
    expect(t.price).toBe("50000001");
    expect(t.size).toBe("1000002");
  });

  test("a redacted (empty) order id is the empty string, not '0x'", () => {
    const t = toEnhancedTrade(
      visibleTrade({ orderHit: new Uint8Array(0) }),
      "m",
      6,
    );
    expect(t.orderHit).toBe("");
  });

  test("the requested market stands in only when the message has none", () => {
    expect(
      toEnhancedTrade(visibleTrade({ marketId: "" }), "req", 6).marketId,
    ).toBe("req");
  });
});

describe("tradeKey", () => {
  const base = visibleTrade();

  test("the raw message and its adapted trade give the same key", () => {
    expect(tradeKey(toEnhancedTrade(base, "m", 6))).toBe(tradeKey(base));
  });

  test("an identical print gives an identical key", () => {
    expect(tradeKey(visibleTrade())).toBe(tradeKey(base));
  });

  const changes: [string, Record<string, unknown>][] = [
    ["market", { marketId: "other::0xb::net::0xq" }],
    ["timestamp", { timestamp: 1700000000124n }],
    ["price", { price: "50000002" }],
    ["qty", { qty: "1000003" }],
    ["buyer role", { buyerIs: 2, sellerIs: 1 }],
    ["maker base address", { makerBaseAddress: "0xmb2" }],
    ["maker quote address", { makerQuoteAddress: "0xmq2" }],
    ["taker base address", { takerBaseAddress: "0xtb2" }],
    ["taker quote address", { takerQuoteAddress: "0xtq2" }],
    ["order hit", { orderHit: new Uint8Array(32).fill(0xce) }],
    ["redacted order hit", { orderHit: new Uint8Array(0) }],
  ];
  for (const [name, change] of changes) {
    test(`changes with the ${name}`, () => {
      const changed = visibleTrade(change);
      expect(tradeKey(changed)).not.toBe(tradeKey(base));
      expect(tradeKey(toEnhancedTrade(changed, "m", 6))).toBe(
        tradeKey(changed),
      );
    });
  }

  test("fields cannot bleed into one another", () => {
    // Moving a character across a field boundary is a different print.
    const a = visibleTrade({
      makerBaseAddress: "0xab",
      makerQuoteAddress: "c",
    });
    const b = visibleTrade({
      makerBaseAddress: "0xa",
      makerQuoteAddress: "bc",
    });
    expect(tradeKey(a)).not.toBe(tradeKey(b));
  });
});
