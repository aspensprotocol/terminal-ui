"use client";

/**
 * Balances panel.
 *
 * Shows one row per (token, chain) slice rather than a single aggregate
 * per ticker — users need to know *where* their funds live because
 * deposit / withdraw / cross-chain routing all care about the specific
 * chain. The store already holds per-chain slices
 * (`chainBalanceSlices`, populated by `useUserBalances`), so we read
 * those directly here instead of the aggregated balances map.
 *
 * A per-token summary row (aggregated across chains) is still visible
 * via the existing top-line `total USD value` footer so the user can
 * eyeball total exposure at a glance.
 */

import { useMemo } from "react";
import { ColumnDef } from "@tanstack/react-table";
import type { ChainBalanceSlice } from "@aspens/terminal-sdk";
import { useExchangeStore } from "@/lib/store";
import { useUserBalances } from "@/lib/hooks";
import { DataTable } from "@/components/ui/data-table";

interface BalanceRow {
  chainNetwork: string;
  tokenTicker: string;
  walletValue: number;
  depositedValue: number;
  lockedValue: number;
  availableValue: number;
  decimals: number;
}

export function Balances() {
  const userAddress = useExchangeStore((state) => state.userAddress);
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  // Keep the hook running — it's what populates the slices we render.
  useUserBalances();
  const slices = useExchangeStore((state) => state.chainBalanceSlices);
  const latestPrices = useExchangeStore((state) => state.latestPrices);

  const rows = useMemo<BalanceRow[]>(() => slices.map(sliceToRow), [slices]);

  const columns = useMemo<ColumnDef<BalanceRow>[]>(
    () => [
      {
        accessorKey: "tokenTicker",
        header: "Asset",
        cell: ({ row }) => (
          <div className="font-medium text-foreground/90">
            {row.original.tokenTicker}
          </div>
        ),
        size: 90,
      },
      {
        accessorKey: "chainNetwork",
        header: "Chain",
        cell: ({ row }) => (
          <div className="text-xs text-muted-foreground/90">
            {row.original.chainNetwork}
          </div>
        ),
        size: 140,
      },
      {
        accessorKey: "walletValue",
        header: () => <div className="text-right">Wallet</div>,
        cell: ({ row }) => (
          <div className="text-right text-muted-foreground/80">
            {formatAmount(row.original.walletValue, row.original.decimals)}
          </div>
        ),
        size: 130,
      },
      {
        accessorKey: "availableValue",
        header: () => <div className="text-right">Available</div>,
        cell: ({ row }) => (
          <div className="text-right font-medium text-foreground/90">
            {formatAmount(row.original.availableValue, row.original.decimals)}
          </div>
        ),
        size: 130,
      },
      {
        accessorKey: "lockedValue",
        header: () => <div className="text-right">Locked</div>,
        cell: ({ row }) => (
          <div className="text-right text-muted-foreground/80">
            {formatAmount(row.original.lockedValue, row.original.decimals)}
          </div>
        ),
        size: 110,
      },
      {
        id: "usdValue",
        accessorFn: (row) =>
          (row.depositedValue + row.walletValue) *
          (latestPrices[row.tokenTicker] ?? 0),
        header: () => <div className="text-right">USD Value</div>,
        cell: ({ row }) => {
          const price = latestPrices[row.original.tokenTicker] ?? 0;
          const total = row.original.depositedValue + row.original.walletValue;
          return (
            <div className="text-right font-medium text-foreground/90">
              $
              {(total * price).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
          );
        },
        size: 130,
        enableSorting: true,
      },
    ],
    [latestPrices],
  );

  if (!isAuthenticated || !userAddress) {
    return (
      <div className="h-full flex pt-20 justify-center">
        <p className="text-muted-foreground text-sm">
          Connect your wallet to view balances
        </p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="h-full flex pt-20 justify-center">
        <p className="text-muted-foreground text-sm">
          No balances yet. Use the Transfer button in the top bar to deposit.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full">
      <DataTable
        columns={columns}
        data={rows}
        emptyMessage="No balances found"
      />
    </div>
  );
}

function sliceToRow(s: ChainBalanceSlice): BalanceRow {
  const scale = 10 ** s.tokenDecimals;
  const walletValue = Number(s.wallet) / scale;
  const depositedValue = Number(s.deposited) / scale;
  const lockedValue = Number(s.locked) / scale;
  const availableValue = Number(s.deposited - s.locked) / scale;
  return {
    chainNetwork: s.chainNetwork,
    tokenTicker: s.tokenTicker,
    walletValue,
    depositedValue,
    lockedValue,
    availableValue,
    decimals: s.tokenDecimals,
  };
}

/** Display-friendly amount: at most 4 fractional digits, no trailing zeros. */
function formatAmount(value: number, decimals: number): string {
  const precision = Math.min(decimals, 4);
  if (value === 0) return "0";
  // Round to the displayed precision, then trim.
  const rounded = value.toFixed(precision);
  return rounded.replace(/\.?0+$/, "");
}
