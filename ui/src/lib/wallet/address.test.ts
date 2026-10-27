/**
 * The Tron address edge: the venue only ever takes a Tron account as `0x`
 * hex, while people read and paste the base58check `T…` form. The pairs
 * below are real Tron accounts (MetaMask's Tron account used on Nile and
 * mainnet USDT), so a conversion that is off by a byte, or that hands the
 * `T…` string through unconverted, yields a different value.
 */

import { describe, expect, test } from "bun:test";
import { displayAddress, settleOverrideAddress } from "./address";

const OWNER_T = "TUtK4fK9WwmAvHF37AMLw5Rn7mzDAXu6qU";
const OWNER_HEX = "0xcf7d5ed79ca1fb60e040cde086c0be1b25289c7a";
const USDT_T = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_HEX = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";

describe("settleOverrideAddress", () => {
  test("settle address input accepts T-form and submits hex", () => {
    expect(settleOverrideAddress("Tron", OWNER_T)).toEqual({
      address: OWNER_HEX,
      error: null,
    });
    expect(settleOverrideAddress("tron", USDT_T)).toEqual({
      address: USDT_HEX,
      error: null,
    });
  });

  test("surrounding whitespace is trimmed before conversion", () => {
    expect(settleOverrideAddress("Tron", `  ${OWNER_T}\n`).address).toBe(
      OWNER_HEX,
    );
  });

  test("hex on a Tron leg is accepted as typed", () => {
    expect(settleOverrideAddress("Tron", USDT_HEX)).toEqual({
      address: USDT_HEX,
      error: null,
    });
  });

  test("a T-form address with a bad checksum is refused", () => {
    // Last character changed: base58 still decodes, the checksum fails.
    const typo = OWNER_T.slice(0, -1) + "r";
    const result = settleOverrideAddress("Tron", typo);
    expect(result.address).toBeNull();
    expect(result.error).toMatch(/checksum/);
  });

  test("a T-form address on an EVM leg is refused, not converted", () => {
    const result = settleOverrideAddress("EVM", OWNER_T);
    expect(result.address).toBeNull();
    expect(result.error).not.toBeNull();
  });

  test("other architectures keep the SDK's validation and the typed spelling", () => {
    const sol = "So11111111111111111111111111111111111111112";
    expect(settleOverrideAddress("Solana", sol)).toEqual({
      address: sol,
      error: null,
    });
    const checksummed = "0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C";
    expect(settleOverrideAddress("EVM", checksummed)).toEqual({
      address: checksummed,
      error: null,
    });
  });
});

describe("displayAddress", () => {
  test("a Tron account renders in its T-form", () => {
    expect(displayAddress("tron", OWNER_HEX)).toBe(OWNER_T);
    expect(
      displayAddress("tron", OWNER_HEX.toUpperCase().replace("0X", "0x")),
    ).toBe(OWNER_T);
  });

  test("EVM and Solana addresses render as they are", () => {
    expect(displayAddress("evm", OWNER_HEX)).toBe(OWNER_HEX);
    expect(displayAddress("solana", "So1ana")).toBe("So1ana");
  });

  test("a Tron value that is not hex is shown as is rather than throwing", () => {
    expect(displayAddress("tron", "—")).toBe("—");
  });
});
