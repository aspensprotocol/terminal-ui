"use client";

import { useState } from "react";
import { useExchangeStore, selectSelectedMarket } from "@/lib/store";
import { useMarkets } from "@/lib/hooks";
import { WalletManager } from "@/components/WalletManager";
import { TransferDialog } from "@/components/TransferDialog";
import { AttestationDialog } from "@/components/AttestationDialog";
import { ChainLogo } from "@/components/ChainLogo";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Image from "next/image";
import Link from "next/link";

export function MarketHeader() {
  const [attestationOpen, setAttestationOpen] = useState(false);
  const { markets, isLoading } = useMarkets();
  const selectedMarketId = useExchangeStore((state) => state.selectedMarketId);
  const selectMarket = useExchangeStore((state) => state.selectMarket);
  const selectedMarket = useExchangeStore(selectSelectedMarket);
  const recentTrades = useExchangeStore((state) => state.recentTrades);
  // Use the adapter-formatted string (capped + zero-trimmed) rather than
  // re-formatting `priceValue` here — keeps every surface of the UI consistent.
  const currentPriceDisplay =
    recentTrades.length > 0 ? (recentTrades[0]?.priceDisplay ?? null) : null;

  return (
    <>
      {/* Header */}
      <div className="mb-4 md:mb-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          {/* Logo — links to the site home ('/'), not the source repo. */}
          <Link
            href="/"
            className="flex items-center gap-3 group select-none cursor-pointer"
          >
            <Image
              src="/logo3.png"
              alt="Exchange Logo"
              width={48}
              height={48}
              className="h-12 w-12 transition-all duration-200 group-hover:brightness-120"
              priority
            />
          </Link>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <TransferDialog />
            <WalletManager />
          </div>
        </div>
      </div>

      {/* Market Selector and Stats */}
      <div className="mb-3">
        <div className="bg-card/50 backdrop-blur-xl border border-border rounded px-3 py-1.5">
          <div className="flex items-center gap-4 text-xs overflow-x-auto">
            {/* Market Selector */}
            {isLoading ? (
              <div className="text-muted-foreground">Loading...</div>
            ) : markets.length === 0 ? (
              <div className="text-muted-foreground">No markets</div>
            ) : (
              <Select
                value={selectedMarketId || ""}
                onValueChange={selectMarket}
              >
                <SelectTrigger className="w-[210px] bg-primary/10 border-primary/40 hover:bg-primary/20 hover:border-primary/50 h-7 text-xs transition-colors">
                  <SelectValue placeholder="Select market" />
                </SelectTrigger>
                <SelectContent className="bg-card backdrop-blur-sm">
                  {markets.map((market) => (
                    <SelectItem key={market.id} value={market.id}>
                      {/* Carry each leg's chain mark so cross-chain markets
                          are distinguishable in the list, not just by ticker. */}
                      <span className="inline-flex items-center gap-1 font-mono whitespace-nowrap">
                        <span className="font-semibold">
                          {market.base_ticker}
                        </span>
                        <ChainLogo network={market.baseChainNetwork} />
                        <span className="text-muted-foreground/50">/</span>
                        <span className="font-semibold">
                          {market.quote_ticker}
                        </span>
                        <ChainLogo network={market.quoteChainNetwork} />
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {selectedMarket && (
              <div className="flex items-center gap-1.5">
                <span className="text-primary/60 uppercase tracking-wider font-semibold">
                  Price
                </span>
                <span className="text-primary font-mono font-bold">
                  {currentPriceDisplay ?? "—"}
                </span>
                <span className="text-muted-foreground/60">
                  {selectedMarket.quote_ticker}
                </span>
                {/* Tick / Lot were removed: the config protocol (GetConfig
                    `Market`) carries no tick_size/lot_size/orderbook_decimals,
                    so they only ever rendered "0". Restore once the venue
                    surfaces them — see tech-debt CONFIG-MARKET-NO-TICKLOT-1. */}
              </div>
            )}

            {/* Right-aligned attestation link; sits on the same row as the
                market dropdown and the Price / Tick / Lot stats. */}
            <button
              type="button"
              onClick={() => setAttestationOpen(true)}
              className="ml-auto text-muted-foreground/70 hover:text-primary uppercase tracking-wider underline decoration-dotted underline-offset-2 transition-colors whitespace-nowrap cursor-pointer"
            >
              Attestation
            </button>
          </div>
        </div>
      </div>

      <AttestationDialog
        open={attestationOpen}
        onOpenChange={setAttestationOpen}
      />
    </>
  );
}
