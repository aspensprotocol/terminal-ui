/**
 * Signing adapter for wallet integration
 *
 * Uses the wallet registry to create the correct signing adapter
 * for the currently active wallet's ecosystem.
 */

import { signMessage } from "wagmi/actions";
import { getWagmiConfig } from "./web3modal-config";
import { walletRegistry } from "./wallet";
import { useExchangeStore } from "./store";
import type { SigningAdapter } from "@exchange/sdk";
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

/**
 * Create a signing adapter that uses wagmi to sign messages.
 * @deprecated Use createActiveSigningAdapter() instead.
 */
export function createWagmiSigningAdapter(): SigningAdapter {
  return {
    async signMessage(hexMessage: string): Promise<string> {
      const signature = await signMessage(getWagmiConfig(), {
        message: { raw: hexMessage as `0x${string}` },
      });
      return signature;
    },
  };
}

/**
 * Sign order bytes using the active wallet
 */
export async function signOrderBytes(hexMessage: string): Promise<string> {
  const adapter = createActiveSigningAdapter();
  return adapter.signMessage(hexMessage);
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string with 0x prefix
 */
export function bytesToHex(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
