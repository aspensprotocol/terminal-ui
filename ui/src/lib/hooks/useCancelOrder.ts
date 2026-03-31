/**
 * Hook for canceling orders
 *
 * Note: Real signing is not yet implemented for chart-based order modifications.
 * The useOrderLines component uses placeholder signatures for now.
 */

import { useState, useCallback } from "react";
import { useExchangeClient } from "./useExchangeClient";

export function useCancelOrder() {
  const client = useExchangeClient();
  const [cancellingOrders, setCancellingOrders] = useState<Set<string>>(new Set());
  const [cancellingAll, setCancellingAll] = useState(false);

  const cancelOrder = useCallback(
    async (userAddress: string, orderId: string) => {
      if (!userAddress) {
        throw new Error("User address required");
      }

      setCancellingOrders((prev) => new Set(prev).add(orderId));

      try {
        // Note: This uses a placeholder signature.
        // Real implementation would need:
        // 1. Market ID and side from the order
        // 2. Token address for the cancel
        // 3. Wallet signature via signCancelOrder
        console.warn("[useCancelOrder] Using placeholder - real signing not implemented for this flow");

        // For now, just log the intent
        console.log(`[useCancelOrder] Would cancel order ${orderId} for ${userAddress}`);
      } catch (err) {
        console.error("Failed to cancel order:", err);
        throw err;
      } finally {
        setCancellingOrders((prev) => {
          const next = new Set(prev);
          next.delete(orderId);
          return next;
        });
      }
    },
    [client]
  );

  const cancelAllOrders = useCallback(
    async (userAddress: string, marketId?: string) => {
      if (!userAddress) {
        throw new Error("User address required");
      }

      setCancellingAll(true);

      try {
        // Note: Cancel all is not fully supported by the gRPC backend
        // Would need to fetch all orders and cancel individually
        console.warn("cancelAllOrders: Not fully implemented for gRPC backend");
      } catch (err) {
        console.error("Failed to cancel all orders:", err);
        throw err;
      } finally {
        setCancellingAll(false);
      }
    },
    [client]
  );

  return {
    cancelOrder,
    cancelAllOrders,
    cancellingOrders,
    cancellingAll,
  };
}
