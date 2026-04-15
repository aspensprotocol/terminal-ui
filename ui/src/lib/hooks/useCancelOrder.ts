/**
 * Hook for cancelling a user's open order.
 *
 * Looks up the order by id from the exchange store, derives the side /
 * market / locked token from it, signs a `OrderToCancel` via the active
 * wallet, and submits via the SDK. The arborter verifies the envelope
 * signature and releases the corresponding locked balance on-chain.
 */

import { useCallback, useState } from "react";
import { signCancelOrder } from "@aspens/terminal-sdk";
import { useExchangeStore } from "@/lib/store";
import { createActiveSigningAdapter } from "@/lib/signing-adapter";
import { useExchangeClient } from "./useExchangeClient";

export function useCancelOrder() {
  const client = useExchangeClient();
  const [cancellingOrders, setCancellingOrders] = useState<Set<string>>(
    new Set(),
  );
  const [cancellingAll, setCancellingAll] = useState(false);

  const cancelOrder = useCallback(
    async (userAddress: string, orderId: string) => {
      if (!userAddress) throw new Error("User address required");

      const { userOrders, markets, userBalances } = useExchangeStore.getState();
      void userBalances; // store-only touch to silence unused lints in future
      const order = userOrders[orderId];
      if (!order) {
        throw new Error(`Order ${orderId} not found in local cache`);
      }
      const market = markets[order.market_id];
      if (!market) {
        throw new Error(
          `Market ${order.market_id} not found — cannot resolve locked token`,
        );
      }

      // The locked token is whichever side's balance funded the order.
      // Buy locks quote, sell locks base. The arborter uses this address
      // to zero out the corresponding `UserBalance.locked` entry.
      const lockedTicker =
        order.side === "buy" ? market.quote_ticker : market.base_ticker;
      const lockedToken = useExchangeStore.getState().tokens[lockedTicker];
      if (!lockedToken || !lockedToken.address) {
        throw new Error(
          `Token ${lockedTicker} not configured (missing address) — cannot build cancel signature`,
        );
      }
      const lockedTokenAddress = lockedToken.address;

      setCancellingOrders((prev) => new Set(prev).add(orderId));
      try {
        const signingAdapter = createActiveSigningAdapter();
        const signature = await signCancelOrder(
          {
            marketId: order.market_id,
            side: order.side,
            tokenAddress: lockedTokenAddress,
            orderId,
          },
          signingAdapter,
        );

        await client.cancelOrder({
          userAddress,
          orderId,
          marketId: order.market_id,
          side: order.side,
          tokenAddress: lockedToken.address,
          signature,
        });
      } catch (err) {
        console.error(`[useCancelOrder] Failed to cancel ${orderId}:`, err);
        throw err;
      } finally {
        setCancellingOrders((prev) => {
          const next = new Set(prev);
          next.delete(orderId);
          return next;
        });
      }
    },
    [client],
  );

  const cancelAllOrders = useCallback(
    async (userAddress: string, marketId?: string) => {
      if (!userAddress) throw new Error("User address required");

      // The arborter has no batch-cancel endpoint — iterate locally.
      // Collect open orders once, then cancel them serially to keep
      // wallet-prompt ordering predictable for the user.
      const { userOrders } = useExchangeStore.getState();
      const targets = Object.values(userOrders).filter(
        (o) =>
          (o.status === "pending" || o.status === "partially_filled") &&
          (!marketId || o.market_id === marketId),
      );
      if (targets.length === 0) return;

      setCancellingAll(true);
      try {
        for (const order of targets) {
          try {
            await cancelOrder(userAddress, order.id);
          } catch (err) {
            // Don't abort the whole batch if one cancel fails — surface
            // the error in the console and continue with the rest.
            console.error(
              `[useCancelOrder] cancel-all skipped ${order.id}:`,
              err,
            );
          }
        }
      } finally {
        setCancellingAll(false);
      }
    },
    [cancelOrder],
  );

  return {
    cancelOrder,
    cancelAllOrders,
    cancellingOrders,
    cancellingAll,
  };
}
