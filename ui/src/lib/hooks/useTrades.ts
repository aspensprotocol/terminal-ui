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

    // Subscribe to trade updates using SDK convenience method
    // SDK now returns fully enhanced trades! 🎉
    const unsubscribe = client.onTrades(marketId, (enhancedTrade) => {
      // SDK already enhanced the trade, just add it to store
      addTrade(enhancedTrade);
    });

    // Cleanup
    return unsubscribe;
  }, [marketId, client, addTrade]);

  return trades;
}
