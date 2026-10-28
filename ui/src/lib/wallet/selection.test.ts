/**
 * The wallet that signs a CANCEL is the wallet that placed the order on
 * its lock leg — not whichever wallet happens to be active. Every case
 * below is built so the wrong rule ("active wallet", "first wallet of
 * that ecosystem") yields a DIFFERENT wallet than the right one, so a
 * regression fails rather than coincidentally passing.
 */

import { describe, expect, test } from "bun:test";
import type { Market } from "@aspensprotocol/sdk-ts";
import { cancelSigningWallet } from "./selection";
import type { ConnectedWallet } from "./types";

const EVM_A: ConnectedWallet = {
  id: "evm:0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
  name: "MetaMask",
  address: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
  ecosystem: "evm",
};
const EVM_B: ConnectedWallet = {
  id: "evm:0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
  name: "Rabby",
  address: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
  ecosystem: "evm",
};
const SOL_S: ConnectedWallet = {
  id: "solana:So1anaWa11etAddressXXXXXXXXXXXXXXXXXXXXXXXX",
  name: "Phantom",
  address: "So1anaWa11etAddressXXXXXXXXXXXXXXXXXXXXXXXX",
  ecosystem: "solana",
};

// One 20-byte account held twice: as an EVM wallet (checksummed) and as a
// Tron wallet (lowercase hex, its T-form converted on connect).
const SHARED_HEX = "0xcf7d5ed79ca1fb60e040cde086c0be1b25289c7a";
const EVM_SHARED: ConnectedWallet = {
  id: "evm:0xCf7D5eD79CA1FB60E040cDe086C0BE1B25289C7A",
  name: "Rabby",
  address: "0xCf7D5eD79CA1FB60E040cDe086C0BE1B25289C7A",
  ecosystem: "evm",
};
const TRON_SHARED: ConnectedWallet = {
  id: `tron:${SHARED_HEX}`,
  name: "MetaMask",
  address: SHARED_HEX,
  ecosystem: "tron",
};

const wallets = (...ws: ConnectedWallet[]) =>
  Object.fromEntries(ws.map((w) => [w.id, w]));

const crossEco: Market = {
  id: "flare::0xbase::solana::Quote111",
  base_ticker: "WFLR",
  quote_ticker: "USDC",
  tick_size: "1",
  lot_size: "1",
  min_size: "1",
  maker_fee_bps: 0,
  taker_fee_bps: 0,
  baseChainArchitecture: "EVM",
  quoteChainArchitecture: "Solana",
};

const tronEvm: Market = {
  ...crossEco,
  id: "tron::0xbase::base-sepolia::0xquote",
  baseChainArchitecture: "Tron",
  quoteChainArchitecture: "EVM",
};

describe("cancelSigningWallet — the order's lock-leg wallet signs", () => {
  test("a BID on a cross-ecosystem market signs with the QUOTE wallet even when the base wallet is active", () => {
    const picked = cancelSigningWallet(
      {
        side: "buy",
        base_account_address: EVM_A.address.toLowerCase(),
        quote_account_address: SOL_S.address,
      },
      crossEco,
      wallets(EVM_A, SOL_S),
      EVM_A.id,
    );
    expect(picked).toBe(SOL_S);
  });

  test("an ASK on the same market signs with the BASE wallet even when the quote wallet is active", () => {
    const picked = cancelSigningWallet(
      {
        side: "sell",
        base_account_address: EVM_A.address.toLowerCase(),
        quote_account_address: SOL_S.address,
      },
      crossEco,
      wallets(EVM_A, SOL_S),
      SOL_S.id,
    );
    expect(picked).toBe(EVM_A);
  });

  test("two wallets of one ecosystem: the ADDRESS on the order wins over the active wallet and over insertion order", () => {
    // EVM_A is both active and first; the order was placed by EVM_B.
    const picked = cancelSigningWallet(
      {
        side: "buy",
        base_account_address: EVM_A.address.toLowerCase(),
        quote_account_address: EVM_B.address.toLowerCase(),
      },
      undefined,
      wallets(EVM_A, EVM_B),
      EVM_A.id,
    );
    expect(picked).toBe(EVM_B);
  });

  test("EVM addresses compare case-insensitively (server canonical is lowercase, wallets report checksummed)", () => {
    const picked = cancelSigningWallet(
      { side: "sell", base_account_address: EVM_B.address.toLowerCase() },
      undefined,
      wallets(EVM_A, EVM_B),
      EVM_A.id,
    );
    expect(picked).toBe(EVM_B);
  });

  test("Solana addresses compare byte-exact — a case-different base58 string is a different key", () => {
    expect(() =>
      cancelSigningWallet(
        { side: "buy", quote_account_address: SOL_S.address.toLowerCase() },
        crossEco,
        wallets(EVM_A, SOL_S),
        SOL_S.id,
      ),
    ).toThrow(SOL_S.address.toLowerCase());
  });

  test("the placing wallet is not connected: refuses, naming the address it needs", () => {
    expect(() =>
      cancelSigningWallet(
        {
          side: "buy",
          base_account_address: EVM_A.address.toLowerCase(),
          quote_account_address: EVM_B.address.toLowerCase(),
        },
        undefined,
        wallets(EVM_A),
        EVM_A.id,
      ),
    ).toThrow(EVM_B.address.toLowerCase());
  });

  test("no addresses on the order (FCE reads): falls back to the lock leg's ECOSYSTEM from the market", () => {
    // BID → quote leg → Solana, even though the EVM wallet is active.
    const picked = cancelSigningWallet(
      { side: "buy" },
      crossEco,
      wallets(EVM_A, SOL_S),
      EVM_A.id,
    );
    expect(picked).toBe(SOL_S);
  });

  test("no addresses and no market: refuses rather than guessing the active wallet", () => {
    expect(() =>
      cancelSigningWallet({ side: "buy" }, undefined, wallets(EVM_A), EVM_A.id),
    ).toThrow(/which wallet/i);
  });

  test("no addresses, market known, but no wallet on the lock leg's ecosystem: refuses naming the ecosystem", () => {
    expect(() =>
      cancelSigningWallet({ side: "buy" }, crossEco, wallets(EVM_A), EVM_A.id),
    ).toThrow(/Solana/);
  });

  test("a Tron-leg order is cancelled by the Tron wallet, not an EVM wallet holding the same bytes", () => {
    // The EVM wallet is first, active and holds the same 20 bytes; only
    // the Tron wallet can sign under the TRON prefix the venue verifies.
    const picked = cancelSigningWallet(
      {
        side: "sell",
        base_account_address: SHARED_HEX,
        quote_account_address: EVM_A.address.toLowerCase(),
      },
      tronEvm,
      wallets(EVM_SHARED, EVM_A, TRON_SHARED),
      EVM_SHARED.id,
    );
    expect(picked).toBe(TRON_SHARED);
  });

  test("an EVM-leg order on the same market is cancelled by the EVM wallet, not the Tron one", () => {
    const picked = cancelSigningWallet(
      {
        side: "buy",
        base_account_address: SHARED_HEX,
        quote_account_address: SHARED_HEX,
      },
      tronEvm,
      wallets(TRON_SHARED, EVM_SHARED),
      TRON_SHARED.id,
    );
    expect(picked).toBe(EVM_SHARED);
  });

  test("Tron hex compares case-insensitively", () => {
    const picked = cancelSigningWallet(
      {
        side: "sell",
        base_account_address: SHARED_HEX.toUpperCase().replace("0X", "0x"),
      },
      tronEvm,
      wallets(TRON_SHARED),
      null,
    );
    expect(picked).toBe(TRON_SHARED);
  });

  test("no addresses, a Tron lock leg, no Tron wallet: refuses naming Tron", () => {
    expect(() =>
      cancelSigningWallet({ side: "sell" }, tronEvm, wallets(EVM_A), EVM_A.id),
    ).toThrow(/a Tron wallet/);
  });
});
