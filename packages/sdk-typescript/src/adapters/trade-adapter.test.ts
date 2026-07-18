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
import { toEnhancedTrade } from "./trade-adapter.js";

/** Visible taker BUYS from a hidden (redacted) maker. */
function redactedMakerTrade(overrides: Record<string, unknown> = {}) {
  return create(TradeSchema, {
    timestamp: 1700000000000n,
    price: "50000000",
    qty: "1000000",
    makerId: "", // redacted
    takerId: "takerid",
    makerBaseAddress: "", // redacted
    makerQuoteAddress: "", // redacted
    takerBaseAddress: "0xtaker",
    takerQuoteAddress: "0xtakerq",
    buyerIs: 2, // TAKER bought
    sellerIs: 1, // MAKER sold
    orderHit: 0n, // redacted
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
