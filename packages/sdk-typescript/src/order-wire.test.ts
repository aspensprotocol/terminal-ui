/**
 * Wire-encoding pinning tests for the signed `Order`.
 *
 * The order envelope signature is computed over the serialized Order
 * proto, and arborter re-encodes the decoded order to verify it. Two
 * invariants must hold or signed orders silently fail verification:
 *
 *   1. `hidden: false` (or omitted) is wire-skipped — byte-identical to
 *      a pre-feature encoding, so existing users' digests are stable.
 *   2. `hidden: true` actually reaches the wire.
 *
 * `nonce` (field 12) carries a third: the arborter derives the canonical order
 * id from the value it decodes out of these bytes, so the encoded field must be
 * EXACTLY the number the caller hashed. JS numbers are doubles and lose
 * integers above 2^53, so that is asserted against a hand-built varint rather
 * than against this module's own round-trip.
 */

import { describe, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { OrderSchema } from "./protos/arborter_pb.js";
import { createOrderMessage, type OrderSigningData } from "./signing.js";

const base: OrderSigningData = {
  side: "buy",
  quantity: "1000",
  price: "50000",
  marketId: "base::0xaa::quote::0xbb",
  baseAccountAddress: "0xb",
  quoteAccountAddress: "0xq",
  postOnly: false,
  nonce: 0n,
};

describe("hidden flag wire encoding", () => {
  test("hidden=false and omitted are byte-identical (wire-skipped)", () => {
    const explicit = toBinary(
      OrderSchema,
      createOrderMessage({ ...base, hidden: false }),
    );
    const omitted = toBinary(OrderSchema, createOrderMessage({ ...base }));
    expect(explicit).toEqual(omitted);
  });

  test("hidden=true reaches the wire", () => {
    const plain = toBinary(OrderSchema, createOrderMessage({ ...base }));
    const flagged = toBinary(
      OrderSchema,
      createOrderMessage({ ...base, hidden: true }),
    );
    expect(flagged).not.toEqual(plain);
    expect(flagged.length).toBeGreaterThan(plain.length);
  });
});

describe("nonce wire encoding", () => {
  // `uint64 nonce = 12` → varint, so the tag byte is (12 << 3) | 0.
  const NONCE_TAG = 0x60;

  /**
   * Base-128 varint, written out here rather than borrowed from the protobuf
   * runtime. Asserting the encoder against itself would pass for any consistent
   * bug; this is the layout the arborter's decoder reads.
   */
  function varint(n: bigint): number[] {
    const out: number[] = [];
    let v = n;
    do {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      out.push(v > 0n ? byte | 0x80 : byte);
    } while (v > 0n);
    return out;
  }

  function encode(nonce: bigint): Uint8Array {
    return toBinary(OrderSchema, createOrderMessage({ ...base, nonce }));
  }

  /**
   * Byte-exact subsequence search. Deliberately not a `join(",").includes(...)`
   * shortcut: that matches across value boundaries — `[1,12,3]` "contains"
   * `[2,3]` — and would report a nonce found that was never encoded.
   */
  function contains(haystack: Uint8Array, needle: number[]): boolean {
    for (let i = 0; i + needle.length <= haystack.length; i++) {
      if (needle.every((b, j) => haystack[i + j] === b)) return true;
    }
    return false;
  }

  test("nonce = 0 is wire-skipped (proto3 default)", () => {
    // The FCE transport depends on exactly this: its adapter rebuilds the
    // order with no nonce at all, and only a wire-skipped zero matches.
    expect([...encode(0n)]).not.toContain(NONCE_TAG);
  });

  test("a nonce above 2^53 is encoded exactly, not as a rounded double", () => {
    // 2^53 + 1: the smallest integer a JS number cannot hold. Anything routing
    // the value through Number() encodes 2^53 here and the arborter derives an
    // id over a number the caller never hashed.
    const n = 9_007_199_254_740_993n;
    expect(contains(encode(n), [NONCE_TAG, ...varint(n)])).toBe(true);
    // And it is genuinely distinguishable from the value it would round to.
    expect(contains(encode(n), [NONCE_TAG, ...varint(n - 1n)])).toBe(false);
  });

  test("the full uint64 range reaches the wire", () => {
    const max = (1n << 64n) - 1n;
    // 10 bytes of 0xff…0x01 — the widest a uint64 varint gets.
    expect(varint(max).length).toBe(10);
    expect(contains(encode(max), [NONCE_TAG, ...varint(max)])).toBe(true);
  });

  test("unix millis — the SDK's own choice — round-trips exactly", () => {
    const n = 1_723_000_000_000n;
    expect(contains(encode(n), [NONCE_TAG, ...varint(n)])).toBe(true);
  });
});
