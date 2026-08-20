/**
 * FCE wire-format conformance tests — the TS mirror of the Rust
 * `aspens::fce` conformance suite and `sdk/docs/fce-transport-design.md`.
 *
 * These pin the envelope byte-for-byte against Flare's `tee-node` so the Go
 * adapter, the Rust SDK, and this TS SDK all speak an identical `/direct` wire
 * format. A drift here is a silent cross-transport auth failure.
 */

import { describe, expect, test } from "bun:test";
import { bytesToHex } from "viem";
import {
  buildDirectInstruction,
  hexBytesToBytes,
  hexJsonToObject,
  OP_COMMAND,
  OP_TYPE_ASPENS,
  toBytes32,
  toBytes32Hex,
} from "./wire.js";

describe("toBytes32 (bytes32(s), NOT a hash)", () => {
  test('"ASPENS" golden vector', () => {
    // A=41 S=53 P=50 E=45 N=4e S=53, right-zero-padded to 32 bytes.
    expect(toBytes32Hex(OP_TYPE_ASPENS)).toBe(
      "0x415350454e530000000000000000000000000000000000000000000000000000",
    );
  });

  test("always 32 bytes, zero-padded tail", () => {
    const b = toBytes32("PLACE_ORDER");
    expect(b.length).toBe(32);
    // 11 content bytes, rest zero.
    expect(b.subarray(11).every((x) => x === 0)).toBe(true);
    // first byte is 'P' = 0x50
    expect(b[0]).toBe(0x50);
  });

  test("empty string → all zeros", () => {
    expect(toBytes32Hex("")).toBe(`0x${"0".repeat(64)}`);
  });

  test("truncates past 32 UTF-8 bytes", () => {
    const long = "X".repeat(40);
    const b = toBytes32(long);
    expect(b.length).toBe(32);
    expect(b.every((x) => x === 0x58)).toBe(true); // all 'X', no overflow
  });

  test("each OPCommand is a distinct 0x + 64-hex string", () => {
    const hexes = Object.values(OP_COMMAND).map(toBytes32Hex);
    for (const h of hexes) expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set(hexes).size).toBe(hexes.length);
  });
});

describe("buildDirectInstruction", () => {
  const payload = { side: "BID", quantity: "1000", marketId: "m" };

  test("opType/opCommand are bytes32 of ASPENS / the command", () => {
    const di = buildDirectInstruction(OP_COMMAND.PLACE_ORDER, payload);
    expect(di.opType).toBe(toBytes32Hex("ASPENS"));
    expect(di.opCommand).toBe(toBytes32Hex("PLACE_ORDER"));
  });

  test("message is 0x + hex of the UTF-8 JSON bytes", () => {
    const di = buildDirectInstruction(OP_COMMAND.PLACE_ORDER, payload);
    const expected = bytesToHex(
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    expect(di.message).toBe(expected);
  });

  test("message round-trips back to the payload", () => {
    const di = buildDirectInstruction(OP_COMMAND.GET_BOOK_STATE, payload);
    expect(hexJsonToObject(di.message)).toEqual(payload);
  });
});

describe("hexutil.Bytes decoding", () => {
  test('"0x" decodes to an empty byte array', () => {
    expect(hexBytesToBytes("0x")).toEqual(new Uint8Array(0));
  });

  test("hexJsonToObject decodes an ActionResult.data payload", () => {
    const obj = { orderId: 7, orderInBook: true, fills: 0 };
    const hex = bytesToHex(new TextEncoder().encode(JSON.stringify(obj)));
    expect(hexJsonToObject(hex)).toEqual(obj);
  });
});

describe("GET_CONFIG (config discovery over FCE)", () => {
  test("golden vector matches the Rust SDK and the Go adapter", () => {
    // G=47 E=45 T=54 _=5f C=43 O=4f N=4e F=46 I=49 G=47 — 10 content bytes,
    // right-zero-padded to 32. Must equal the Go adapter's
    // teeutils.ToHash("GET_CONFIG") and the Rust OP_GET_CONFIG.
    expect(toBytes32Hex(OP_COMMAND.GET_CONFIG)).toBe(
      "0x4745545f434f4e46494700000000000000000000000000000000000000000000",
    );
  });

  test("is part of OP_COMMAND", () => {
    expect(OP_COMMAND.GET_CONFIG).toBe("GET_CONFIG");
  });
});
