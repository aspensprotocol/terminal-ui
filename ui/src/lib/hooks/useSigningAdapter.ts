import { useMemo } from "react";
import { useExchangeStore } from "@/lib/store";
import { walletRegistry } from "@/lib/wallet";
import type { SigningAdapter } from "@exchange/sdk";
import type { ChainEcosystem } from "@/lib/wallet/types";

/**
 * Returns a SigningAdapter for the currently active wallet.
 * Returns null if no wallet is active.
 */
export function useSigningAdapter(): SigningAdapter | null {
  const activeWalletId = useExchangeStore((state) => state.activeWalletId);
  const connectedWallets = useExchangeStore((state) => state.connectedWallets);

  return useMemo(() => {
    if (!activeWalletId) return null;
    const wallet = connectedWallets[activeWalletId];
    if (!wallet) return null;

    const adapter = walletRegistry.getAdapter(wallet.ecosystem as ChainEcosystem);
    if (!adapter) return null;

    return adapter.createSigningAdapter(wallet.address);
  }, [activeWalletId, connectedWallets]);
}
