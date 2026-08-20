/**
 * Hook for cancelling a user's open order.
 *
 * Looks up the order by id from the exchange store, derives the side /
 * market / collateral token from it, signs a `OrderToCancel` via the active
 * wallet, and submits via the SDK. The arborter verifies the envelope
 * signature and closes the order's collateral lot, returning the reservation
 * to the account's available balance. That is an off-chain ledger move — no
 * transaction, no gas, nothing on the contract changes.
 */

import { useCallback, useState } from "react";
import {
  signCancelOrder,
  type CancelSigningData,
  type SigningAdapter,
} from "@aspens/terminal-sdk";
import { useExchangeStore, type CancelledOrderEntry } from "@/lib/store";
import { createActiveSigningAdapter } from "@/lib/signing-adapter";
import { useExchangeClient } from "./useExchangeClient";
import type { Order } from "@/lib/types/exchange";

/**
 * External effects the sign+submit step needs, injected so the NOT_FOUND
 * decision below is testable without rendering the hook — this repo has
 * no hook-testing convention (no `renderHook` usage anywhere in
 * `ui/src`), so the testable surface is a plain async function taking an
 * already-resolved `order` rather than the hook itself.
 */
export interface CancelSubmissionDeps {
  createSigningAdapter: () => SigningAdapter;
  signCancel: (
    data: CancelSigningData,
    adapter: SigningAdapter,
  ) => Promise<Uint8Array>;
  submitCancel: (params: {
    userAddress: string;
    orderId: string;
    marketId: string;
    side: Order["side"];
    tokenAddress: string;
    signature: Uint8Array;
  }) => Promise<unknown>;
  recordCancelledOrder: (entry: CancelledOrderEntry) => void;
  removeHiddenOrder: (orderId: string) => void;
}

/**
 * Sign and submit a cancel for an already-resolved order, then reconcile
 * local state with the result.
 */
export async function submitCancelOrder(
  order: Order,
  collateralTokenAddress: string,
  userAddress: string,
  orderId: string,
  deps: CancelSubmissionDeps,
): Promise<void> {
  try {
    const signingAdapter = deps.createSigningAdapter();
    const signature = await deps.signCancel(
      {
        marketId: order.market_id,
        side: order.side,
        tokenAddress: collateralTokenAddress,
        orderId,
      },
      signingAdapter,
    );

    await deps.submitCancel({
      userAddress,
      orderId,
      marketId: order.market_id,
      side: order.side,
      tokenAddress: collateralTokenAddress,
      signature,
    });

    // The arborter drops cancelled orders from its orderbook, so
    // they'll be invisible on the next getOrders poll. Persist an
    // entry keyed by orderId so Order History can still show the
    // cancellation across refreshes.
    deps.recordCancelledOrder({
      orderId,
      marketId: order.market_id,
      side: order.side,
      priceDisplay: order.priceDisplay ?? order.price ?? "",
      sizeDisplay: order.sizeDisplay ?? order.size ?? "",
      cancelledAt: Date.now(),
      userAddress,
    });

    // A cancelled hidden order must also leave the local tracking
    // slice, or setOrders would re-inject it forever.
    if (order.hidden) {
      deps.removeHiddenOrder(orderId);
    }
  } catch (err) {
    // The arborter answers NOT_FOUND for a cancel of any order that is no
    // longer live in its book — a replayed cancel, or one racing a fill
    // that just completed. Since matching moved inside the arborter's
    // single-writer actor (2026-08), that is the deliberate wire answer,
    // not a hidden-order special case. From the user's perspective the row
    // should just disappear: it is the same outcome a successful cancel
    // would have produced locally. Any other error still propagates.
    const message = err instanceof Error ? err.message : String(err);
    const isNotFound = /not[ _-]?found/i.test(message);
    if (isNotFound) {
      console.warn(
        `[useCancelOrder] Order ${orderId} already gone at arborter (not found) — removing local row`,
        err,
      );
      deps.recordCancelledOrder({
        orderId,
        marketId: order.market_id,
        side: order.side,
        priceDisplay: order.priceDisplay ?? order.price ?? "",
        sizeDisplay: order.sizeDisplay ?? order.size ?? "",
        cancelledAt: Date.now(),
        userAddress,
      });
      // Only hidden orders live in the hidden-orders slice, so this stays
      // hidden-gated — it's the local-tracking cleanup, not the NOT_FOUND
      // decision above (which now applies to every order).
      if (order.hidden) {
        deps.removeHiddenOrder(orderId);
      }
      return;
    }
    console.error(`[useCancelOrder] Failed to cancel ${orderId}:`, err);
    throw err;
  }
}

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
          `Market ${order.market_id} not found — cannot resolve collateral token`,
        );
      }

      // The collateral token is whichever side's balance funded the order —
      // an order commits a budget denominated in the asset it gives, so a buy
      // commits quote and a sell commits base. The arborter needs the address
      // to identify the ledger lot to close.
      const collateralTicker =
        order.side === "buy" ? market.quote_ticker : market.base_ticker;
      const collateralToken =
        useExchangeStore.getState().tokens[collateralTicker];
      if (!collateralToken || !collateralToken.address) {
        throw new Error(
          `Token ${collateralTicker} not configured (missing address) — cannot build cancel signature`,
        );
      }
      const collateralTokenAddress = collateralToken.address;

      setCancellingOrders((prev) => new Set(prev).add(orderId));
      try {
        await submitCancelOrder(
          order,
          collateralTokenAddress,
          userAddress,
          orderId,
          {
            createSigningAdapter: createActiveSigningAdapter,
            signCancel: signCancelOrder,
            submitCancel: (params) => client.cancelOrder(params),
            recordCancelledOrder: (entry) =>
              useExchangeStore.getState().recordCancelledOrder(entry),
            removeHiddenOrder: (id) =>
              useExchangeStore.getState().removeHiddenOrder(id),
          },
        );
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
