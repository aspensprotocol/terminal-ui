/**
 * Signing adapter for wallet integration
 *
 * Uses the wallet registry to create the correct signing adapter
 * for the currently active wallet's ecosystem.
 */

import { walletRegistry } from "./wallet";
import { useExchangeStore } from "./store";
import type { SigningAdapter } from "@aspens/terminal-sdk";
import type { ChainEcosystem } from "./wallet/types";

/**
 * Create a signing adapter for the currently active wallet.
 * Uses the wallet registry to determine the correct ecosystem adapter.
 */
export function createActiveSigningAdapter(): SigningAdapter {
  const { activeWalletId, connectedWallets } = useExchangeStore.getState();

  if (!activeWalletId) {
    throw new Error("No active wallet");
  }

  const wallet = connectedWallets[activeWalletId];
  if (!wallet) {
    throw new Error("Active wallet not found");
  }

  const adapter = walletRegistry.getAdapter(wallet.ecosystem as ChainEcosystem);
  if (!adapter) {
    throw new Error(`No adapter registered for ecosystem: ${wallet.ecosystem}`);
  }

  return adapter.createSigningAdapter(wallet.address);
}
