/**
 * Hook for managing user trades with WebSocket subscriptions
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useExchangeStore } from "../store";
import { useExchangeClient } from "./useExchangeClient";

/**
 * Hook that fetches initial user trades via REST and subscribes to WebSocket updates
 * Trades are stored in Zustand store and automatically updated via WebSocket
 */
export function useUserTrades() {
  const client = useExchangeClient();
  const userAddress = useExchangeStore((state) => state.userAddress);
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  const selectedMarketId = useExchangeStore((state) => state.selectedMarketId);
  const setUserTrades = useExchangeStore((state) => state.setUserTrades);
  const addUserTrade = useExchangeStore((state) => state.addUserTrade);
  const userTrades = useExchangeStore((state) => state.userTrades);

  // Track if this is the initial load to avoid toasting for existing data
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    if (!userAddress || !isAuthenticated) {
      setUserTrades([]);
      isInitialLoadRef.current = true;
      return;
    }

    // Fetch initial trades via REST (returns enhanced trades from SDK)
    const fetchInitialTrades = async () => {
      try {
        const result = await client.getTrades(userAddress, selectedMarketId || undefined);
        // Limit to 50 most recent trades
        setUserTrades(result.slice(0, 50));
      } catch (err) {
        console.error("Failed to fetch initial trades:", err);
        setUserTrades([]);
      }
    };

    fetchInitialTrades();

    // Set a short delay to mark initial load as complete
    const timer = setTimeout(() => {
      isInitialLoadRef.current = false;
    }, 2000);

    // Subscribe to WebSocket trade updates
    const unsubscribe = client.onUserFills(userAddress, (trade) => {
      addUserTrade(trade);

      // Show toast notification for new fills
      if (!isInitialLoadRef.current) {
        const side = trade.buyer_address === userAddress ? "buy" : "sell";
        toast.success(
          `Fill: ${side.toUpperCase()} ${trade.sizeDisplay} ${trade.market_id.split("/")[0]} @ ${trade.priceDisplay}`,
          {
            description: `Market: ${trade.market_id}`,
            duration: 4000,
          }
        );
      }
    });

    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [userAddress, isAuthenticated, selectedMarketId, client, setUserTrades, addUserTrade]);

  // Filter trades by selected market if market is selected
  return selectedMarketId ? userTrades.filter((t) => t.market_id === selectedMarketId) : userTrades;
}
