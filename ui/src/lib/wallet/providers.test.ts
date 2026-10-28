/**
 * The picker shows ONE row per wallet product, merged across ecosystems.
 * Every case is built so the wrong rule — no dedupe, no merge, alphabetical
 * instead of installed-first — yields a DIFFERENT row list than the right
 * one, so a regression fails rather than coincidentally passing.
 */

import { describe, expect, test } from "bun:test";
import {
  mergeWalletProviders,
  type EvmConnectorLike,
  type SolanaWalletLike,
  type TronWalletLike,
} from "./providers";

const GENERIC_INJECTED: EvmConnectorLike = {
  id: "injected",
  name: "Injected",
  type: "injected",
};
const METAMASK: EvmConnectorLike = {
  id: "io.metamask",
  name: "MetaMask",
  type: "injected",
  rdns: "io.metamask",
  icon: "data:mm",
};
const PHANTOM_EVM: EvmConnectorLike = {
  id: "app.phantom",
  name: "Phantom",
  type: "injected",
  rdns: "app.phantom",
  icon: "data:phantom-evm",
};
const WALLETCONNECT: EvmConnectorLike = {
  id: "walletConnect",
  name: "WalletConnect",
  type: "walletConnect",
};
const PHANTOM_SOL: SolanaWalletLike = {
  name: "Phantom",
  icon: "data:phantom-sol",
  url: "https://phantom.app",
  readyState: "Installed",
};
const BACKPACK: SolanaWalletLike = {
  name: "Backpack",
  icon: "data:backpack",
  url: "https://backpack.app",
  readyState: "NotDetected",
};

const METAMASK_TRON: TronWalletLike = {
  name: "MetaMask",
  icon: "data:mm-tron",
  installed: true,
};

/** A page with `window.ethereum`, as every browser with an EVM wallet has. */
const PRESENT = { hasInjectedProvider: true };

const names = (rows: ReturnType<typeof mergeWalletProviders>) =>
  rows.map((r) => r.name);

describe("mergeWalletProviders", () => {
  test("drops the generic injected connector once EIP-6963 discovered one", () => {
    const rows = mergeWalletProviders(
      [GENERIC_INJECTED, METAMASK],
      [],
      PRESENT,
    );
    expect(names(rows)).toEqual(["MetaMask"]);
    expect(rows[0]?.evm?.connectorId).toBe("io.metamask");
  });

  test("keeps the generic injected connector when nothing was discovered", () => {
    const rows = mergeWalletProviders(
      [GENERIC_INJECTED, WALLETCONNECT],
      [],
      PRESENT,
    );
    expect(names(rows)).toEqual(["Browser Wallet", "WalletConnect"]);
    expect(rows[0]?.evm?.connectorId).toBe("injected");
    expect(rows[0]?.installed).toBe(true);
  });

  test("drops the generic injected connector when no provider is injected", () => {
    // Keeping it would offer a "Browser Wallet" row that cannot connect.
    const rows = mergeWalletProviders([GENERIC_INJECTED, WALLETCONNECT], [], {
      hasInjectedProvider: false,
    });
    expect(names(rows)).toEqual(["WalletConnect"]);
  });

  test("merges the same product across ecosystems into one row", () => {
    const rows = mergeWalletProviders(
      [PHANTOM_EVM, METAMASK],
      [PHANTOM_SOL, BACKPACK],
      PRESENT,
    );
    // 3 rows, not 4: Phantom appears once with both legs.
    expect(rows).toHaveLength(3);
    const phantom = rows.find((r) => r.name === "Phantom");
    expect(phantom?.evm?.connectorId).toBe("app.phantom");
    expect(phantom?.solana?.walletName).toBe("Phantom");
    // The EVM-only and Solana-only rows carry exactly one leg.
    const mm = rows.find((r) => r.name === "MetaMask");
    expect(mm?.evm).toBeDefined();
    expect(mm?.solana).toBeUndefined();
    const bp = rows.find((r) => r.name === "Backpack");
    expect(bp?.evm).toBeUndefined();
    expect(bp?.solana?.walletName).toBe("Backpack");
  });

  test("merge is case-insensitive on the product name", () => {
    const rows = mergeWalletProviders(
      [{ ...PHANTOM_EVM, name: "phantom" }],
      [PHANTOM_SOL],
      PRESENT,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.evm).toBeDefined();
    expect(rows[0]?.solana).toBeDefined();
  });

  test("installed rows sort first, then by name", () => {
    // Alphabetical order would be Backpack, Phantom, WalletConnect, Zeta.
    const zeta: EvmConnectorLike = {
      id: "xyz.zeta",
      name: "Zeta",
      type: "injected",
      rdns: "xyz.zeta",
    };
    const rows = mergeWalletProviders(
      [WALLETCONNECT, zeta],
      [BACKPACK, PHANTOM_SOL],
      PRESENT,
    );
    expect(names(rows)).toEqual([
      "Phantom",
      "Zeta",
      "Backpack",
      "WalletConnect",
    ]);
  });

  test("a Solana wallet installed on one leg marks the merged row installed", () => {
    const rows = mergeWalletProviders(
      [{ ...WALLETCONNECT, name: "Phantom", id: "phantom-wc" }],
      [PHANTOM_SOL],
      PRESENT,
    );
    expect(rows[0]?.installed).toBe(true);
  });

  test("drops Unsupported Solana wallets", () => {
    const rows = mergeWalletProviders(
      [],
      [{ ...BACKPACK, readyState: "Unsupported" }, PHANTOM_SOL],
      PRESENT,
    );
    expect(names(rows)).toEqual(["Phantom"]);
  });

  test("an ecosystem filter drops other-ecosystem rows and strips their leg", () => {
    const rows = mergeWalletProviders(
      [PHANTOM_EVM, METAMASK],
      [PHANTOM_SOL, BACKPACK],
      { ...PRESENT, filter: "solana" },
    );
    expect(names(rows)).toEqual(["Phantom", "Backpack"]);
    expect(rows[0]?.evm).toBeUndefined();
    expect(rows[0]?.solana).toBeDefined();
  });

  test("icon prefers the Solana adapter's, then the EVM connector's", () => {
    const rows = mergeWalletProviders([PHANTOM_EVM], [PHANTOM_SOL], PRESENT);
    expect(rows[0]?.icon).toBe("data:phantom-sol");
    const evmOnly = mergeWalletProviders([PHANTOM_EVM], [], PRESENT);
    expect(evmOnly[0]?.icon).toBe("data:phantom-evm");
  });

  test("picker row merges the MetaMask tron leg", () => {
    // One MetaMask row carrying both legs; a merge that ignored the Tron
    // leg's name would show two MetaMask rows.
    const rows = mergeWalletProviders([METAMASK], [PHANTOM_SOL], {
      ...PRESENT,
      tronWallets: [METAMASK_TRON],
    });
    expect(names(rows)).toEqual(["MetaMask", "Phantom"]);
    const mm = rows[0];
    expect(mm?.evm?.connectorId).toBe("io.metamask");
    expect(mm?.tron?.walletName).toBe("MetaMask");
    expect(mm?.solana).toBeUndefined();
    // The Tron leg does not leak onto another product's row.
    expect(rows[1]?.tron).toBeUndefined();
  });

  test("no Tron leg is offered when the venue lists no Tron chain", () => {
    const rows = mergeWalletProviders([METAMASK], [], PRESENT);
    expect(rows[0]?.tron).toBeUndefined();
  });

  test("a tron filter keeps only Tron legs", () => {
    const rows = mergeWalletProviders(
      [PHANTOM_EVM, METAMASK],
      [PHANTOM_SOL, BACKPACK],
      { ...PRESENT, filter: "tron", tronWallets: [METAMASK_TRON] },
    );
    expect(names(rows)).toEqual(["MetaMask"]);
    expect(rows[0]?.tron).toBeDefined();
    expect(rows[0]?.evm).toBeUndefined();
    expect(rows[0]?.solana).toBeUndefined();
  });

  test("an evm or solana filter strips the Tron leg", () => {
    const evm = mergeWalletProviders([METAMASK], [], {
      ...PRESENT,
      filter: "evm",
      tronWallets: [METAMASK_TRON],
    });
    expect(names(evm)).toEqual(["MetaMask"]);
    expect(evm[0]?.tron).toBeUndefined();
    const sol = mergeWalletProviders([METAMASK], [PHANTOM_SOL], {
      ...PRESENT,
      filter: "solana",
      tronWallets: [METAMASK_TRON],
    });
    expect(names(sol)).toEqual(["Phantom"]);
  });

  test("an installed Tron leg alone marks its row installed", () => {
    // Alphabetical order would put Backpack first; installed-first puts
    // the Tron-only MetaMask row ahead of it.
    const rows = mergeWalletProviders([], [BACKPACK], {
      ...PRESENT,
      tronWallets: [METAMASK_TRON],
    });
    expect(names(rows)).toEqual(["MetaMask", "Backpack"]);
    expect(rows[0]?.installed).toBe(true);
    const absent = mergeWalletProviders([], [], {
      ...PRESENT,
      tronWallets: [{ ...METAMASK_TRON, installed: false }],
    });
    expect(absent[0]?.installed).toBe(false);
  });
});
