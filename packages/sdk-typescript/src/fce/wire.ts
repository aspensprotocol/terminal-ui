/**
 * FCE action-envelope wire format (mirrors the Rust `aspens::fce::wire` and
 * `sdk/docs/fce-transport-design.md`).
 *
 * Pinned against Flare's `tee-node@v0.0.22`:
 * - `pkg/utils/utils.go` — `ToHash` is `bytes32(s)`, NOT a hash.
 * - `pkg/types/direct.go` — `DirectInstruction` is JSON `{opType, opCommand, message}`.
 *
 * All three fields are go-ethereum types serialized as `0x`-prefixed lowercase
 * hex: `common.Hash` → `0x` + 64 hex; `hexutil.Bytes` → `0x` + hex (empty = `0x`).
 */

import { bytesToHex, hexToBytes, type Hex } from "viem";

/** The single OPType this extension answers to. */
export const OP_TYPE_ASPENS = "ASPENS";

/**
 * Direct-action OPCommands (off-chain). `DEPOSIT` is the on-chain instruction
 * channel, not a direct action — see the design doc §6.
 */
export const OP_COMMAND = {
  WITHDRAW: "WITHDRAW",
  PLACE_ORDER: "PLACE_ORDER",
  CANCEL_ORDER: "CANCEL_ORDER",
  GET_MY_STATE: "GET_MY_STATE",
  GET_BOOK_STATE: "GET_BOOK_STATE",
  EXPORT_HISTORY: "EXPORT_HISTORY",
  /**
   * Config discovery over FCE. Without it a client can read but not WRITE:
   * building a signed order needs the market's pair decimals and the
   * base/quote chains' curves, which live only in the arborter config.
   */
  GET_CONFIG: "GET_CONFIG",
} as const;
export type OpCommand = (typeof OP_COMMAND)[keyof typeof OP_COMMAND];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * `bytes32(s)` — copy the UTF-8 bytes of `s` into a 32-byte array, truncating
 * past 32 bytes and zero-padding the tail. Mirrors `teeutils.ToHash` /
 * `send-direct`'s `toBytes32` (Solidity `bytes32("ASPENS")`). NOT a hash.
 */
export function toBytes32(s: string): Uint8Array {
  const enc = textEncoder.encode(s);
  const out = new Uint8Array(32);
  out.set(enc.subarray(0, 32));
  return out;
}

/** `bytes32(s)` as `0x`-prefixed 64-char hex. */
export function toBytes32Hex(s: string): Hex {
  return bytesToHex(toBytes32(s));
}

/** The direct-action wire object the ext-proxy `/direct` endpoint accepts. */
export interface DirectInstruction {
  opType: Hex;
  opCommand: Hex;
  message: Hex;
}

/**
 * Build a `DirectInstruction` for `command`, carrying `payload` (a plain object
 * serialized to JSON — the message is `0x` + hex of the UTF-8 JSON bytes).
 */
export function buildDirectInstruction(
  command: OpCommand,
  payload: unknown,
): DirectInstruction {
  const json = JSON.stringify(payload);
  return {
    opType: toBytes32Hex(OP_TYPE_ASPENS),
    opCommand: toBytes32Hex(command),
    message: bytesToHex(textEncoder.encode(json)),
  };
}

/** Encode a `Uint8Array` (e.g. a signature) as go-ethereum `hexutil.Bytes`. */
export function bytesToHexBytes(b: Uint8Array): Hex {
  return bytesToHex(b);
}

/** Decode `0x`-hex (`hexutil.Bytes`) back to raw bytes; `"0x"` → empty. */
export function hexBytesToBytes(h: Hex): Uint8Array {
  return h === "0x" ? new Uint8Array(0) : hexToBytes(h);
}

/** Decode `0x`-hex holding JSON bytes into a parsed object (`ActionResult.data`). */
export function hexJsonToObject<T>(h: Hex): T {
  return JSON.parse(textDecoder.decode(hexBytesToBytes(h))) as T;
}
