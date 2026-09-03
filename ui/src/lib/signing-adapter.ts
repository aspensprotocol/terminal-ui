/**
 * Signing adapters for wallet integration.
 *
 * Uses the wallet registry to create the signing adapter for a wallet's
 * ecosystem. Two entry points: one for the ACTIVE wallet (order placement
 * makes the giving-leg wallet active first, then signs), and one for a
 * specific connected wallet (a cancel must be signed by the wallet that
 * placed the order, whatever is active).
 */

import { walletRegistry } from "./wallet";
import { useExchangeStore } from "./store";
import type { SigningAdapter } from "@aspens/terminal-sdk";
import type { ChainEcosystem, ConnectedWallet } from "./wallet/types";

/**
 * Create a signing adapter for one specific connected wallet.
 */
export function createSigningAdapterForWallet(
  wallet: ConnectedWallet,
): SigningAdapter {
  const adapter = walletRegistry.getAdapter(wallet.ecosystem as ChainEcosystem);
  if (!adapter) {
    throw new Error(`No adapter registered for ecosystem: ${wallet.ecosystem}`);
  }
  return adapter.createSigningAdapter(wallet.address);
}

/**
 * Create a signing adapter for the currently active wallet.
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

  return createSigningAdapterForWallet(wallet);
}
