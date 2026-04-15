/**
 * Hook for managing user balances with on-chain refresh.
 *
 * Balances are computed by per-chain queries (ERC-20 / MidribV2 on EVM,
 * SPL token + UserBalance PDA on Solana) against every connected wallet.
 * The arborter doesn't surface balances directly — only in-flight orders
 * — so the authoritative state lives on-chain. A polling loop keeps the
 * store in sync since there's no push channel.
 */

import { useEffect, useMemo } from "react";
import type { WalletBinding } from "@exchange/sdk";
import { useExchangeStore } from "../store";
import { useExchangeClient } from "./useExchangeClient";

/** How often to re-fetch balances from RPC. Cheap enough at room temperature. */
const BALANCE_POLL_INTERVAL_MS = 15_000;

export function useUserBalances() {
  const client = useExchangeClient();
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  const setBalances = useExchangeStore((state) => state.setBalances);
  const balancesRecord = useExchangeStore((state) => state.userBalances);
  const connectedWallets = useExchangeStore((state) => state.connectedWallets);

  // Serialize the wallet bindings into a stable identity for the effect's
  // dependency list — otherwise a new `Object.values(...)` array on every
  // render would thrash the poll.
  const wallets = useMemo<WalletBinding[]>(
    () =>
      Object.values(connectedWallets).map((w) => ({
        address: w.address,
        ecosystem: w.ecosystem as WalletBinding["ecosystem"],
      })),
    [connectedWallets],
  );
  const walletKey = useMemo(
    () =>
      wallets
        .map((w) => `${w.ecosystem}:${w.address}`)
        .sort()
        .join("|"),
    [wallets],
  );

  const balances = useMemo(
    () => Object.values(balancesRecord),
    [balancesRecord],
  );

  useEffect(() => {
    if (!isAuthenticated || wallets.length === 0) {
      setBalances([]);
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await client.getBalances(wallets);
        if (!cancelled) setBalances(result);
      } catch (err) {
        if (!cancelled) console.error("Failed to fetch balances:", err);
      }
    };

    refresh();
    const interval = setInterval(refresh, BALANCE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // walletKey captures the meaningful identity of `wallets`; adding the
    // array itself would re-run every render because of .map().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, walletKey, client, setBalances]);

  return balances;
}
