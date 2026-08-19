/**
 * EVM addresses compare case-insensitively (EIP-55 checksums are display
 * only). The arborter emits its canonical LOWERCASE form on trade taker
 * fields, while wallets hand the UI a checksummed string — a strict `===`
 * silently misclassifies the user's own taker-side trades. The mixed-case
 * fixture below is the whole test: an already-lowercase fixture would
 * pass against the broken `===` comparison too.
 */

import { describe, expect, test } from "bun:test";
import { sameAddress } from "./utils";

// Mixed-case on purpose — lowercasing it must change the string, or the
// test below proves nothing about case-insensitivity.
const MIXED_CASE_USER_ADDRESS = "0xAbCd1234567890aBcDeF1234567890ABCDEF12E1";

describe("sameAddress", () => {
  test("matches a lowercased arborter address against a checksummed wallet address", () => {
    const lowercased = MIXED_CASE_USER_ADDRESS.toLowerCase();
    expect(lowercased).not.toBe(MIXED_CASE_USER_ADDRESS); // fixture sanity check
    expect(sameAddress(lowercased, MIXED_CASE_USER_ADDRESS)).toBe(true);
  });

  test("does not match genuinely different addresses", () => {
    expect(
      sameAddress(
        MIXED_CASE_USER_ADDRESS,
        "0x0000000000000000000000000000000000dEaD",
      ),
    ).toBe(false);
  });

  test("undefined never equals anything, even another undefined", () => {
    expect(sameAddress(undefined, undefined)).toBe(false);
    expect(sameAddress(MIXED_CASE_USER_ADDRESS, undefined)).toBe(false);
    expect(sameAddress(undefined, MIXED_CASE_USER_ADDRESS)).toBe(false);
  });

  test("null never equals anything either, even another null (store's userAddress is string | null)", () => {
    expect(sameAddress(null, null)).toBe(false);
    expect(sameAddress(MIXED_CASE_USER_ADDRESS, null)).toBe(false);
    expect(sameAddress(null, undefined)).toBe(false);
  });

  test("mirrors the trade buyer/seller side-derivation call site: lowercase buyer_address vs checksummed userAddress still derives 'buy'", () => {
    const buyerAddress = MIXED_CASE_USER_ADDRESS.toLowerCase(); // arborter's canonical form
    const side = sameAddress(buyerAddress, MIXED_CASE_USER_ADDRESS)
      ? "buy"
      : "sell";
    expect(side).toBe("buy");
  });
});
