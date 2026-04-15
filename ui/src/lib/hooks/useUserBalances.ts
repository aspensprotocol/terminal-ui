/**
 * Hook for managing user balances with on-chain refresh.
 *
 * Fetches per-chain balance slices (wallet + deposited + locked for
 * every token on every chain the user has a wallet on), stores them
 * in the exchange store so other UI (the Transfer dialog, future
 * per-chain breakdowns) can consume the raw shape, and also derives
 * the ticker-aggregated `EnhancedBalance[]` the Balances panel reads.
 *
 * The arborter doesn't push balances — it only sees in-flight orders
 * — so polling on an interval is the correct shape. 15s is generous
 * enough not to spam RPCs and short enough that a user's deposit lands
 * visibly within a single interval.
 */

import { useEffect, useMemo } from "react";
import {
  fetchChainBalanceSlices,
  type ChainBalanceSlice,
  type EnhancedBalance,
  type WalletBinding,
} from "@exchange/sdk";
import { useExchangeStore } from "../store";
import { useExchangeClient } from "./useExchangeClient";

/** How often to re-fetch balances from RPC. Cheap enough at room temperature. */
const BALANCE_POLL_INTERVAL_MS = 15_000;

export function useUserBalances() {
  const client = useExchangeClient();
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  const setBalances = useExchangeStore((state) => state.setBalances);
  const setChainBalanceSlices = useExchangeStore(
    (state) => state.setChainBalanceSlices,
  );
  const balancesRecord = useExchangeStore((state) => state.userBalances);
  const connectedWallets = useExchangeStore((state) => state.connectedWallets);

  // Serialise the wallet bindings into a stable identity for the effect's
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
      setChainBalanceSlices([]);
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      const config = client.cache.getConfig();
      if (!config) return;
      try {
        const slices = await fetchChainBalanceSlices({ wallets, config });
        if (cancelled) return;
        setChainBalanceSlices(slices);
        setBalances(aggregateSlicesByTicker(slices));
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
    // walletKey captures the meaningful identity of `wallets`; adding
    // the array itself would re-run every render because of .map().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, walletKey, client, setBalances, setChainBalanceSlices]);

  return balances;
}

/**
 * Collapse per-chain slices into `EnhancedBalance` rows keyed by
 * token ticker — the shape the Balances panel consumes today. The
 * `chainBalanceSlices` store field preserves the unaggregated data
 * for callers that need the per-chain breakdown.
 */
function aggregateSlicesByTicker(
  slices: ChainBalanceSlice[],
): EnhancedBalance[] {
  const byTicker = new Map<
    string,
    { deposited: bigint; locked: bigint; decimals: number }
  >();
  for (const s of slices) {
    const prior = byTicker.get(s.tokenTicker);
    if (prior) {
      prior.deposited += s.deposited;
      prior.locked += s.locked;
    } else {
      byTicker.set(s.tokenTicker, {
        deposited: s.deposited,
        locked: s.locked,
        decimals: s.tokenDecimals,
      });
    }
  }

  const out: EnhancedBalance[] = [];
  for (const [ticker, agg] of byTicker) {
    const scale = 10 ** agg.decimals;
    const amountValue = Number(agg.deposited) / scale;
    const lockedValue = Number(agg.locked) / scale;
    const available = amountValue - lockedValue;
    out.push({
      user_address: "",
      token_ticker: ticker,
      amount: agg.deposited.toString(),
      open_interest: "0",
      locked: agg.locked.toString(),
      updated_at: new Date().toISOString(),
      amountValue,
      lockedValue,
      displayAmount: amountValue.toString(),
      displayOpenInterest: "0",
      amountDisplay: amountValue.toString(),
      available: (agg.deposited - agg.locked).toString(),
      displayAvailable: available.toString(),
    });
  }
  return out;
}
