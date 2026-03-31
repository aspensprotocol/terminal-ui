"use client";

import { useMemo } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { useExchangeStore } from "@/lib/store";
import { useUserBalances } from "@/lib/hooks";
import { DataTable } from "@/components/ui/data-table";
import type { Balance } from "@/lib/types/exchange";

export function Balances() {
  const userAddress = useExchangeStore((state) => state.userAddress);
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  const balances = useUserBalances();
  const latestPrices = useExchangeStore((state) => state.latestPrices);

  const columns = useMemo<ColumnDef<Balance>[]>(
    () => [
      {
        accessorKey: "token_ticker",
        header: "Asset",
        cell: ({ row }) => <div className="font-medium text-foreground/90">{row.getValue("token_ticker")}</div>,
        size: 100,
      },
      {
        accessorKey: "amountDisplay",
        header: () => <div className="text-right">Total Balance</div>,
        cell: ({ row }) => {
          const balance = row.original;
          return <div className="text-right font-medium text-foreground/90">{balance.amountValue.toFixed(2)}</div>;
        },
        size: 150,
      },
      {
        id: "available",
        accessorFn: (row) => row.amountValue - row.lockedValue,
        header: () => <div className="text-right">Available Balance</div>,
        cell: ({ row }) => {
          const balance = row.original;
          const available = balance.amountValue - balance.lockedValue;
          return <div className="text-right text-muted-foreground/80">{available.toFixed(2)}</div>;
        },
        size: 150,
        enableSorting: true,
      },
      {
        id: "usdValue",
        accessorFn: (row) => {
          const price = latestPrices[row.token_ticker] ?? 0;
          return row.amountValue * price;
        },
        header: () => <div className="text-right">USD Value</div>,
        cell: ({ row }) => {
          const balance = row.original;
          const price = latestPrices[balance.token_ticker] ?? 0;
          const usdValue = balance.amountValue * price;
          return (
            <div className="text-right font-medium text-foreground/90">
              ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          );
        },
        size: 150,
        enableSorting: true,
      },
    ],
    [latestPrices]
  );

  if (!isAuthenticated || !userAddress) {
    return (
      <div className="h-full flex pt-20 justify-center">
        <p className="text-muted-foreground text-sm">Connect your wallet to view balances</p>
      </div>
    );
  }

  if (balances.length === 0) {
    return (
      <div className="h-full flex pt-20 justify-center">
        <p className="text-muted-foreground text-sm">
          No balances found. Use the faucet button in the top bar to get tokens!
        </p>
      </div>
    );
  }

  return (
    <div className="h-full">
      <DataTable columns={columns} data={balances} emptyMessage="No balances found" />
    </div>
  );
}
