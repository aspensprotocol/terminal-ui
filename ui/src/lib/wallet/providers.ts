/**
 * The wallet picker's row model: ONE row per wallet product, merged across
 * ecosystems. Phantom ships both an EVM provider (discovered by wagmi via
 * EIP-6963) and a Solana wallet-standard adapter; the user sees one
 * "Phantom" row with a chain mark per leg, not two rows.
 *
 * Pure: takes plain shapes of wagmi connectors and Solana wallet adapters so
 * the rules test without either library.
 */

import type { ChainEcosystem } from "./types";

/** The fields of a wagmi `Connector` the picker reads. */
export interface EvmConnectorLike {
  id: string;
  name: string;
  /** `"injected"` for browser-extension providers; other values are remote. */
  type: string;
  icon?: string;
  /** Set on EIP-6963-discovered injected connectors; absent on the generic one. */
  rdns?: string | readonly string[];
}

/** `WalletReadyState` from `@solana/wallet-adapter-base`, as a plain string. */
export type SolanaReadyState =
  | "Installed"
  | "NotDetected"
  | "Loadable"
  | "Unsupported";

/** The fields of a Solana wallet-adapter `Wallet` the picker reads. */
export interface SolanaWalletLike {
  name: string;
  icon: string;
  url: string;
  readyState: SolanaReadyState;
}

export interface WalletProviderRow {
  /** Normalised name; stable React key. */
  key: string;
  name: string;
  icon?: string;
  /** A browser extension for this product was detected on at least one leg. */
  installed: boolean;
  evm?: { connectorId: string };
  solana?: { walletName: string; readyState: SolanaReadyState; url: string };
}

/** wagmi's catch-all `injected()` connector id. */
const GENERIC_INJECTED_ID = "injected";

function normalise(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Merge wagmi connectors and Solana wallets into picker rows.
 *
 * - The generic `injected` connector is dropped once any EIP-6963 provider
 *   was discovered (each of those is a named injected connector), and when
 *   no injected provider exists at all. Alone with a provider present, it
 *   stays as "Browser Wallet" so a wallet that predates EIP-6963 remains
 *   reachable.
 * - `Unsupported` Solana wallets are dropped.
 * - Rows merge on the case-insensitive product name.
 * - Installed rows sort first; ties break by name.
 * - `filter` keeps only rows with that ecosystem's leg and strips the other.
 */
export interface MergeOptions {
  /** Show only this ecosystem's legs. */
  filter?: ChainEcosystem | null;
  /**
   * Whether the page has ANY injected EVM provider (`window.ethereum`).
   * wagmi lists its generic `injected` connector unconditionally, so without
   * this the picker would offer a "Browser Wallet" that cannot connect.
   */
  hasInjectedProvider: boolean;
}

export function mergeWalletProviders(
  evmConnectors: readonly EvmConnectorLike[],
  solanaWallets: readonly SolanaWalletLike[],
  { filter = null, hasInjectedProvider }: MergeOptions,
): WalletProviderRow[] {
  const rows = new Map<string, WalletProviderRow>();

  const upsert = (name: string): WalletProviderRow => {
    const key = normalise(name);
    let row = rows.get(key);
    if (!row) {
      row = { key, name, installed: false };
      rows.set(key, row);
    }
    return row;
  };

  if (filter !== "solana") {
    const discovered = evmConnectors.some(
      (c) => c.type === "injected" && c.id !== GENERIC_INJECTED_ID,
    );
    for (const c of evmConnectors) {
      const generic = c.id === GENERIC_INJECTED_ID;
      if (generic && (discovered || !hasInjectedProvider)) continue;
      const row = upsert(generic ? "Browser Wallet" : c.name);
      row.evm = { connectorId: c.id };
      if (c.type === "injected") row.installed = true;
      if (c.icon && !row.icon) row.icon = c.icon;
    }
  }

  if (filter !== "evm") {
    for (const w of solanaWallets) {
      if (w.readyState === "Unsupported") continue;
      const row = upsert(w.name);
      row.solana = {
        walletName: w.name,
        readyState: w.readyState,
        url: w.url,
      };
      if (w.readyState === "Installed") row.installed = true;
      // The Solana adapter's icon wins: it is the product's own mark, whereas
      // an EVM leg may carry a generic or lower-resolution one.
      if (w.icon) row.icon = w.icon;
    }
  }

  return [...rows.values()].sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
