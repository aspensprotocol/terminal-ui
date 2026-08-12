import { describe, expect, it } from "bun:test";
import { hexJsonToObject } from "./wire.js";
import type { GetMyStateResponse } from "./payloads.js";

/**
 * The production failure: the arborter's matching engine held order
 * 173852891691592598. The browser read it, sent it back to cancel, and the
 * arborter answered NotFound while the order sat in the book with 25.9 WFLR
 * still reserved against it.
 */
const TRUE_ID = "173852891691592598";
const OTHER_ID = "6755360711411187334";

const toHexJson = (o: unknown) =>
  ("0x" + Buffer.from(JSON.stringify(o), "utf8").toString("hex")) as `0x${string}`;

describe("u64 ids on the FCE wire", () => {
  it("survives decoding when the arborter quotes it", () => {
    const wire = toHexJson({
      openOrders: [
        { orderId: TRUE_ID, marketId: "m", side: "ASK", price: "1", quantity: "2", state: "CONFIRMED" },
        { orderId: OTHER_ID, marketId: "m", side: "ASK", price: "1", quantity: "2", state: "CONFIRMED" },
      ],
    });
    const decoded = hexJsonToObject<GetMyStateResponse>(wire);
    expect(decoded.openOrders[0]!.orderId).toBe(TRUE_ID);
    expect(decoded.openOrders[1]!.orderId).toBe(OTHER_ID);
  });

  it("demonstrates the bug this replaced: a bare number is rounded by JSON.parse", () => {
    // Kept as executable documentation. If anyone reverts the wire to bare
    // numbers, this is what the client would silently receive.
    const bare = JSON.parse(`{"orderId":${TRUE_ID}}`) as { orderId: number };
    expect(String(bare.orderId)).not.toBe(TRUE_ID);
    expect(String(bare.orderId)).toBe("173852891691592600");
  });

  it("Number() destroys the id on the way out — the outbound half", () => {
    // client.ts used to do exactly this before sending a cancel.
    expect(String(Number(TRUE_ID))).toBe("173852891691592600");
    expect(String(Number(OTHER_ID))).toBe("6755360711411188000");
    // Passing the string through, or via BigInt, is exact.
    expect(String(BigInt(TRUE_ID))).toBe(TRUE_ID);
  });

  it("round-trips every id a u64 can hold", () => {
    for (const id of [
      TRUE_ID,
      OTHER_ID,
      "9007199254740993", // 2^53 + 1, the first unsafe integer
      "18446744073709551615", // max uint64
      "0",
    ]) {
      const wire = toHexJson({ openOrders: [{ orderId: id }] });
      const back = hexJsonToObject<{ openOrders: { orderId: string }[] }>(wire);
      expect(back.openOrders[0]!.orderId).toBe(id);
    }
  });
});
