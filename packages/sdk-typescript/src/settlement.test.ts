/**
 * The two `Order` account addresses are the per-chain SETTLEMENT addresses:
 * the venue credits fill proceeds to those exact strings, only the
 * collateral-side one is authenticated by the envelope signature, and funds
 * credited to an address are withdrawable only by the holder of that
 * address's key — a mistyped address is stranded funds.
 *
 * `validateSettleAddress` mirrors the arborter's SendOrder entry rule
 * (0x-prefixed 20-byte hex on EVM legs, 32-byte base58 on Solana) plus one
 * client-only rule: a mixed-case EVM address claims an EIP-55 checksum and
 * is refused when the checksum is wrong. The venue deliberately accepts any
 * casing (the field is byte-verbatim inside the signature), so catching the
 * typo is the client's job or nobody's.
 *
 * `resolveLegAddresses` decides both addresses from the connected wallets
 * and optional overrides: the GIVE leg (buy → quote, sell → base) is what
 * the venue verifies the signature against and draws collateral from, so an
 * override there may only restate the signing wallet's address; the RECEIVE
 * leg is where proceeds settle and may be redirected to any well-formed
 * address on its chain.
 *
 * The Rust SDK carries the same contract in
 * `aspens::orders::validate_settle_address` and the send-order leg
 * resolution — behavior changes must land in both.
 */

import { describe, expect, test } from "bun:test";
import { checksumAddress } from "viem";
import {
  resolveLegAddresses,
  sameSettleAddress,
  validateSettleAddress,
} from "./settlement";

/** Computed, not hand-typed: a hand-typed "checksummed" fixture can be
 * silently wrong-cased and flip every assertion built on it. The address
 * is the EIP-55 spec's own example, whose checksum form is known to be
 * mixed-case. */
const CHECKSUMMED = checksumAddress(
  "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
);
const OTHER_EVM = checksumAddress("0x00000000000000000000000000000000feedbeef");
/** The Solana System Program pubkey: 32 zero bytes in base58. */
const SOL_PUBKEY = "11111111111111111111111111111111";
const OTHER_SOL = "So11111111111111111111111111111111111111112";

describe("validateSettleAddress", () => {
  test("accepts a checksummed EVM address", () => {
    // The fixture must actually be mixed-case or the checksum path is
    // untested.
    expect(CHECKSUMMED).not.toBe(CHECKSUMMED.toLowerCase());
    expect(validateSettleAddress("evm", CHECKSUMMED)).toBeNull();
  });

  test("accepts an all-lowercase EVM address (no checksum claimed)", () => {
    expect(validateSettleAddress("evm", CHECKSUMMED.toLowerCase())).toBeNull();
  });

  test("rejects a bad EIP-55 checksum", () => {
    // Swap the case of the first `aA` pair; still mixed-case, no longer
    // the checksum.
    const bad = CHECKSUMMED.replace("aA", "Aa");
    expect(bad).not.toBe(CHECKSUMMED);
    expect(bad).not.toBe(bad.toLowerCase());
    expect(validateSettleAddress("evm", bad)).toContain("checksum");
  });

  test("rejects unprefixed hex on an EVM leg", () => {
    // The venue's ledger only canonicalizes 0x-prefixed addresses; an
    // unprefixed spelling would key a separate balance.
    expect(validateSettleAddress("evm", CHECKSUMMED.slice(2))).not.toBeNull();
  });

  test("rejects wrong length or garbage on an EVM leg", () => {
    expect(validateSettleAddress("evm", "0xAbCdEf01")).not.toBeNull();
    expect(
      validateSettleAddress("evm", "0xnot-hex-at-all-000000000000000000000000"),
    ).not.toBeNull();
    expect(validateSettleAddress("evm", "")).not.toBeNull();
  });

  test("accepts a 32-byte base58 pubkey on a Solana leg", () => {
    expect(validateSettleAddress("solana", SOL_PUBKEY)).toBeNull();
    expect(validateSettleAddress("solana", OTHER_SOL)).toBeNull();
    // Architecture matching is case-insensitive, like the config strings.
    expect(validateSettleAddress("Solana", SOL_PUBKEY)).toBeNull();
  });

  test("rejects non-pubkeys on a Solana leg", () => {
    expect(validateSettleAddress("solana", "abc")).not.toBeNull();
    // `0` is outside the base58 alphabet, so an EVM address fails loudly
    // rather than being reinterpreted.
    expect(validateSettleAddress("solana", CHECKSUMMED)).not.toBeNull();
    expect(validateSettleAddress("solana", "")).not.toBeNull();
  });
});

describe("sameSettleAddress", () => {
  test("EVM hex is case-insensitive", () => {
    expect(
      sameSettleAddress("evm", CHECKSUMMED, CHECKSUMMED.toLowerCase()),
    ).toBe(true);
    expect(sameSettleAddress("evm", CHECKSUMMED, OTHER_EVM)).toBe(false);
  });

  test("base58 is case-sensitive", () => {
    expect(sameSettleAddress("solana", OTHER_SOL, OTHER_SOL)).toBe(true);
    expect(
      sameSettleAddress("solana", OTHER_SOL, OTHER_SOL.toLowerCase()),
    ).toBe(false);
  });
});

describe("resolveLegAddresses", () => {
  const evmEvm = {
    baseArchitecture: "evm",
    quoteArchitecture: "evm",
    baseWalletAddress: CHECKSUMMED,
    quoteWalletAddress: CHECKSUMMED,
  };

  test("defaults to the wallets' addresses on both sides", () => {
    for (const side of ["buy", "sell"] as const) {
      expect(resolveLegAddresses({ ...evmEvm, side })).toEqual({
        baseAddress: CHECKSUMMED,
        quoteAddress: CHECKSUMMED,
      });
    }
  });

  test("a receive-leg override redirects settlement", () => {
    // A SELL gives base and receives quote: the quote address is free.
    expect(
      resolveLegAddresses({
        ...evmEvm,
        side: "sell",
        quoteOverride: OTHER_EVM,
      }),
    ).toEqual({ baseAddress: CHECKSUMMED, quoteAddress: OTHER_EVM });
    // A BUY gives quote and receives base: the base address is free.
    expect(
      resolveLegAddresses({ ...evmEvm, side: "buy", baseOverride: OTHER_EVM }),
    ).toEqual({ baseAddress: OTHER_EVM, quoteAddress: CHECKSUMMED });
  });

  test("a give-leg override may only restate the signer", () => {
    expect(() =>
      resolveLegAddresses({ ...evmEvm, side: "sell", baseOverride: OTHER_EVM }),
    ).toThrow(/sign/);
    expect(() =>
      resolveLegAddresses({ ...evmEvm, side: "buy", quoteOverride: OTHER_EVM }),
    ).toThrow(/sign/);
    // Restating it in different casing IS the same address, and the
    // caller's spelling is kept (the field is byte-verbatim once signed).
    expect(
      resolveLegAddresses({
        ...evmEvm,
        side: "sell",
        baseOverride: CHECKSUMMED.toLowerCase(),
      }).baseAddress,
    ).toBe(CHECKSUMMED.toLowerCase());
  });

  test("a malformed receive-leg override is refused", () => {
    for (const bad of ["abc", CHECKSUMMED.slice(2), ""]) {
      expect(() =>
        resolveLegAddresses({ ...evmEvm, side: "sell", quoteOverride: bad }),
      ).toThrow();
    }
  });

  const evmSol = {
    baseArchitecture: "evm",
    quoteArchitecture: "solana",
    baseWalletAddress: CHECKSUMMED,
    quoteWalletAddress: OTHER_SOL,
  };

  test("cross-architecture: each leg is validated for its own chain", () => {
    // A BUY gives quote (Solana signer); its EVM receive leg may redirect
    // — to an EVM address only.
    expect(
      resolveLegAddresses({ ...evmSol, side: "buy", baseOverride: OTHER_EVM }),
    ).toEqual({ baseAddress: OTHER_EVM, quoteAddress: OTHER_SOL });
    expect(() =>
      resolveLegAddresses({ ...evmSol, side: "buy", baseOverride: SOL_PUBKEY }),
    ).toThrow();
    // The mirror: a SELL receives Solana-side; that override must be a
    // 32-byte base58 pubkey.
    expect(
      resolveLegAddresses({
        ...evmSol,
        side: "sell",
        quoteOverride: SOL_PUBKEY,
      }),
    ).toEqual({ baseAddress: CHECKSUMMED, quoteAddress: SOL_PUBKEY });
    expect(() =>
      resolveLegAddresses({
        ...evmSol,
        side: "sell",
        quoteOverride: OTHER_EVM,
      }),
    ).toThrow();
  });

  test("a missing receive-leg wallet demands an override", () => {
    // EVM wallet only, on an EVM/Solana market: a SELL signs with the EVM
    // (base) wallet but has nowhere to settle the Solana leg — the caller
    // must supply an address.
    const oneWallet = { ...evmSol, quoteWalletAddress: null };
    expect(() => resolveLegAddresses({ ...oneWallet, side: "sell" })).toThrow(
      /address/,
    );
    expect(
      resolveLegAddresses({
        ...oneWallet,
        side: "sell",
        quoteOverride: SOL_PUBKEY,
      }).quoteAddress,
    ).toBe(SOL_PUBKEY);
  });

  test("a missing give-leg wallet is unsignable, override or not", () => {
    const oneWallet = { ...evmSol, quoteWalletAddress: null };
    expect(() =>
      resolveLegAddresses({
        ...oneWallet,
        side: "buy",
        quoteOverride: OTHER_SOL,
      }),
    ).toThrow(/wallet/);
  });
});
