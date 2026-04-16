"use client";

/**
 * Order History — the user's closed-order timeline.
 *
 * Two data sources merged into one time-sorted table:
 *   - **Filled orders** — from `useUserTrades`; the arborter's
 *     `historical_closed_trades` feed (aka "your fills").
 *   - **Cancelled orders** — from the store's persisted
 *     `cancelledOrders` log. The arborter drops cancelled orders from
 *     its orderbook, so without the local log they'd vanish entirely.
 *     Entries are written by `useCancelOrder` on a successful cancel.
 *
 * If / when arborter grows a real "closed-orders-by-trader" endpoint
 * this component should switch to it — the local log is a workaround
 * for that gap, not the long-term design.
 */

import { useMemo } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { useExchangeStore, type CancelledOrderEntry } from "@/lib/store";
import { useUserTrades } from "@/lib/hooks";
import type { Trade } from "@/lib/types/exchange";
import { DataTable } from "@/components/ui/data-table";

type HistoryRow = {
  id: string;
  timestamp: Date;
  marketId: string;
  side: "buy" | "sell";
  priceDisplay: string;
  sizeDisplay: string;
  status: "filled" | "cancelled";
  /** For USD value calc on filled rows; cancelled rows show "—". */
  priceValue: number | null;
  sizeValue: number | null;
};

export function OrderHistory() {
  const userAddress = useExchangeStore((state) => state.userAddress);
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  const cancelledOrders = useExchangeStore((state) => state.cancelledOrders);
  // useUserTrades populates `userTrades` for the current market; re-read here.
  const userTrades = useUserTrades();

  const rows = useMemo<HistoryRow[]>(() => {
    const filled = userTrades.map((t): HistoryRow => {
      // timestamp is typed as string on ApiTrade but some upstream
      // conversions hand back a Date; normalise defensively.
      const rawTs = (t as Trade & { timestamp: unknown }).timestamp as
        | string
        | number
        | Date;
      const timestamp =
        rawTs instanceof Date
          ? rawTs
          : new Date(typeof rawTs === "string" ? rawTs : Number(rawTs));
      return {
        id: `fill-${t.id}`,
        timestamp,
        marketId: t.market_id,
        side:
          (t as Trade & { side?: "buy" | "sell" }).side ??
          (t.buyer_address === userAddress ? "buy" : "sell"),
        priceDisplay: t.priceDisplay,
        sizeDisplay: t.sizeDisplay,
        status: "filled",
        priceValue: t.priceValue,
        sizeValue: t.sizeValue,
      };
    });
    const cancelled = cancelledOrders
      // Show only the active user's cancellations — the log may carry
      // entries from a prior connected address, and localStorage is
      // per-browser-not-per-wallet.
      .filter((e) => !userAddress || e.userAddress === userAddress)
      .map(
        (e: CancelledOrderEntry): HistoryRow => ({
          id: `cancel-${e.orderId}`,
          timestamp: new Date(e.cancelledAt),
          marketId: e.marketId,
          side: e.side,
          priceDisplay: e.priceDisplay || "—",
          sizeDisplay: e.sizeDisplay || "—",
          status: "cancelled",
          priceValue: null,
          sizeValue: null,
        }),
      );
    // Newest first — matches how every other historical panel in the
    // app orders things.
    return [...filled, ...cancelled].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
  }, [userTrades, cancelledOrders, userAddress]);

  const columns = useMemo<ColumnDef<HistoryRow>[]>(
    () => [
      {
        accessorKey: "timestamp",
        header: "Time",
        cell: ({ row }) => (
          <div className="text-muted-foreground/80 text-xs">
            {row.original.timestamp.toLocaleString()}
          </div>
        ),
        size: 160,
      },
      {
        accessorKey: "marketId",
        header: "Market",
        cell: ({ row }) => (
          <div className="font-medium text-foreground/90">
            {row.original.marketId}
          </div>
        ),
        size: 120,
      },
      {
        accessorKey: "side",
        header: "Side",
        cell: ({ row }) => {
          const side = row.original.side;
          return (
            <span
              className={`inline-flex items-center text-xs px-2 py-1 font-medium rounded ${
                side === "buy"
                  ? "bg-green-500/10 text-green-500 border border-green-500/20"
                  : "bg-red-500/10 text-red-500 border border-red-500/20"
              }`}
            >
              {side === "buy" ? "Buy" : "Sell"}
            </span>
          );
        },
        size: 80,
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const status = row.original.status;
          return (
            <span
              className={`inline-flex items-center text-xs px-2 py-1 font-medium rounded ${
                status === "filled"
                  ? "bg-primary/10 text-primary border border-primary/20"
                  : "bg-muted text-muted-foreground border border-border/50"
              }`}
            >
              {status === "filled" ? "Filled" : "Cancelled"}
            </span>
          );
        },
        size: 110,
      },
      {
        accessorKey: "priceDisplay",
        header: () => <div className="text-right">Price</div>,
        cell: ({ row }) => (
          <div className="text-right font-medium text-foreground/90">
            {row.original.priceDisplay}
          </div>
        ),
        size: 120,
      },
      {
        accessorKey: "sizeDisplay",
        header: () => <div className="text-right">Size</div>,
        cell: ({ row }) => (
          <div className="text-right text-muted-foreground/80">
            {row.original.sizeDisplay}
          </div>
        ),
        size: 120,
      },
      {
        id: "usdValue",
        accessorFn: (row) =>
          row.priceValue !== null && row.sizeValue !== null
            ? row.priceValue * row.sizeValue
            : 0,
        header: () => <div className="text-right">USD Value</div>,
        cell: ({ row }) => {
          if (
            row.original.priceValue === null ||
            row.original.sizeValue === null
          ) {
            return <div className="text-right text-muted-foreground/60">—</div>;
          }
          const usdValue = row.original.priceValue * row.original.sizeValue;
          return (
            <div className="text-right font-medium text-foreground/90">
              $
              {usdValue.toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
          );
        },
        size: 120,
        enableSorting: true,
      },
    ],
    [],
  );

  if (!isAuthenticated || !userAddress) {
    return (
      <div className="h-full flex pt-20 justify-center">
        <p className="text-muted-foreground text-sm">
          Connect your wallet to view order history
        </p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="h-full flex pt-20 justify-center">
        <p className="text-muted-foreground text-sm">
          No order history yet. Filled and cancelled orders will land here.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full">
      <DataTable
        columns={columns}
        data={rows}
        emptyMessage="No order history"
      />
    </div>
  );
}
