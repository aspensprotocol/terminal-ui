/**
 * Parity tests for the wallet-signature normalization layer.
 *
 * The arborter accepts a 64-byte `r||s` signature regardless of the
 * signing curve. EVM wallets return 65 bytes (ECDSA, with trailing
 * recovery byte) and Solana wallets return 64 bytes (Ed25519). This
 * regression suite pins both paths so a future refactor can't silently
 * corrupt one of them.
 */

import { describe, expect, test } from "bun:test";
import { normalizeWalletSignature } from "./signing.js";

describe("normalizeWalletSignature", () => {
  test("strips the recovery byte from a 65-byte EVM ECDSA signature", () => {
    // r[32] || s[32] || v[1] — the EVM wire format from wagmi/viem/ethers.
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    const v = new Uint8Array([0x1c]); // recovery byte (27 / 28 canonical)
    const sig = new Uint8Array([...r, ...s, ...v]);

    const out = normalizeWalletSignature(sig);

    expect(out.length).toBe(64);
    expect(out.slice(0, 32)).toEqual(r);
    expect(out.slice(32, 64)).toEqual(s);
    // v is dropped — arborter recovers the address from message + r||s.
  });

  test("passes a 64-byte Solana Ed25519 signature through unchanged", () => {
    // Ed25519 signatures produced by @solana/wallet-adapter are already
    // 64 bytes (r||s). Any slicing would corrupt them.
    const sig = new Uint8Array(64).fill(0xab);

    const out = normalizeWalletSignature(sig);

    expect(out.length).toBe(64);
    expect(out).toEqual(sig);
    // Same reference semantics aren't required, but value equality is.
  });

  test("throws on an unexpected signature length", () => {
    // A wallet adapter returning something this code doesn't understand
    // must fail loudly rather than ship a bogus signature that the
    // arborter would silently reject.
    const tooShort = new Uint8Array(63);
    const tooLong = new Uint8Array(66);
    const way_off = new Uint8Array(32); // e.g. a hash, not a signature

    expect(() => normalizeWalletSignature(tooShort)).toThrow(/length 63/);
    expect(() => normalizeWalletSignature(tooLong)).toThrow(/length 66/);
    expect(() => normalizeWalletSignature(way_off)).toThrow(/length 32/);
  });
});
