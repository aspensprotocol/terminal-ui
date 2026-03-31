import { useEffect, useRef, useMemo } from "react";
import { useExchangeStore } from "@/lib/store";
import { useExchangeClient } from "@/lib/hooks/useExchangeClient";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import type { IChartingLibraryWidget, IOrderLineAdapter } from "../../../public/vendor/trading-view/charting_library";

/**
 * Hook to manage order lines on the TradingView chart
 * Renders visual lines for open limit orders with cancel functionality
 */
export function useOrderLines(widgetRef: React.RefObject<IChartingLibraryWidget | null>, isChartReady: boolean) {
  const selectedMarketId = useExchangeStore((state) => state.selectedMarketId);
  const userAddress = useExchangeStore((state) => state.userAddress);
  const userOrdersRecord = useExchangeStore((state) => state.userOrders);
  const client = useExchangeClient();
  const orderLinesRef = useRef<Map<string, IOrderLineAdapter>>(new Map());

  // Convert Record to array with useMemo to avoid recreating on every render
  const userOrders = useMemo(() => Object.values(userOrdersRecord), [userOrdersRecord]);

  useEffect(() => {
    if (!widgetRef.current || !selectedMarketId || !isChartReady) return;

    const chart = widgetRef.current.activeChart();
    if (!chart) return;

    // Filter orders for current market that are open limit orders
    const marketOrders = userOrders.filter(
      (order) =>
        order.market_id === selectedMarketId &&
        (order.status === "pending" || order.status === "partially_filled") &&
        order.order_type === "limit"
    );

    // Remove lines for orders that no longer exist or are not open
    for (const [orderId, line] of orderLinesRef.current) {
      if (!marketOrders.find((o) => o.id === orderId)) {
        try {
          line.remove();
        } catch (err) {
          console.warn("[OrderLines] Failed to remove order line:", err);
        }
        orderLinesRef.current.delete(orderId);
      }
    }

    // Create lines for new orders
    for (const order of marketOrders) {
      if (!orderLinesRef.current.has(order.id)) {
        try {
          const isBuy = order.side === "buy";
          const lineColor = isBuy ? "#22c55e" : "#ef4444";
          const bgColor = isBuy ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)";
          const textColor = isBuy ? "#bbf7d0" : "#fecaca";
          const sideText = isBuy ? "BUY" : "SELL";

          const line = chart.createOrderLine();
          line
            .setPrice(order.priceValue)
            .setText(`${sideText} ${order.priceDisplay} × ${order.sizeDisplay}`)
            .setQuantity(order.sizeDisplay)
            .setLineColor(lineColor)
            .setLineWidth(2)
            .setBodyBorderColor(lineColor)
            .setBodyBackgroundColor(bgColor)
            .setBodyTextColor(textColor)
            .setQuantityBorderColor(lineColor)
            .setQuantityBackgroundColor(bgColor)
            .setQuantityTextColor(textColor)
            .setCancelButtonBorderColor("#ef4444")
            .setCancelButtonBackgroundColor("rgba(239, 68, 68, 0.2)")
            .setCancelButtonIconColor("#ef4444")
            .setCancelTooltip("Cancel Order")
            .setTooltip(`${sideText} Order: ${order.sizeDisplay} @ ${order.priceDisplay}`)
            .setEditable(true)
            .setModifyTooltip("Drag to modify price")
            // eslint-disable-next-line react-hooks/unsupported-syntax
            .onMove(async function (this: { getPrice: () => number }) {
              if (!userAddress) {
                console.warn("[OrderLines] Cannot modify: user not authenticated");
                return;
              }

              const newPrice = this.getPrice();
              console.log(`[OrderLines] Moving order ${order.id} from ${order.priceValue} to ${newPrice}`);

              // Note: Order modification via chart requires wallet signing
              // This is not yet implemented - show a warning
              console.warn("[OrderLines] Order modification via chart requires wallet signing - not yet implemented");
              alert("Order modification via chart is not yet available. Please use the order panel.");
            })
            .onCancel(async () => {
              if (!userAddress) {
                console.warn("[OrderLines] Cannot cancel: user not authenticated");
                return;
              }

              // Note: Order cancellation via chart requires wallet signing
              // This is not yet implemented - show a warning
              console.warn("[OrderLines] Order cancellation via chart requires wallet signing - not yet implemented");
              alert("Order cancellation via chart is not yet available. Please use the order panel.");
            });

          orderLinesRef.current.set(order.id, line);
        } catch (err) {
          console.warn("[OrderLines] Failed to create order line:", err);
        }
      }
    }
  }, [userOrders, selectedMarketId, isChartReady, userAddress, client, widgetRef]);

  // Cleanup on unmount
  useEffect(() => {
    const orderLines = orderLinesRef.current;
    return () => {
      for (const line of orderLines.values()) {
        try {
          line.remove();
        } catch (err) {
          console.warn("[OrderLines] Failed to remove order line on cleanup:", err);
        }
      }
      orderLines.clear();
    };
  }, []);
}
