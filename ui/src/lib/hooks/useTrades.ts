/**
 * Hook for subscribing to trade updates
 */

import { useEffect } from "react";
import { useExchangeStore, selectRecentTrades } from "../store";
import { useExchangeClient } from "./useExchangeClient";

export function useTrades(marketId: string | null) {
  const client = useExchangeClient();
  const addTrade = useExchangeStore((state) => state.addTrade);
  const trades = useExchangeStore(selectRecentTrades);

  useEffect(() => {
    if (!marketId) return;

    // Subscribe to trade updates; the SDK delivers fully enhanced trades, so
    // each one goes straight into the store.
    const unsubscribe = client.onTrades(marketId, (enhancedTrade) => {
      addTrade(enhancedTrade);
    });

    // Cleanup
    return unsubscribe;
  }, [marketId, client, addTrade]);

  return trades;
}
