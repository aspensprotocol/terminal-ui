"use client";

/**
 * The Composite tab: one merged book over every market that trades the
 * selected market's base token against a like-kind quote, each row marked
 * with the chain(s) its price rests on. See `lib/composite.ts` for what
 * "like-kind" means and why rows are merged on value, not raw price.
 *
 * Clicking a row selects that row's market (the trade panel targets one
 * market, and the price lives on that one) and then sets the price. The
 * composite itself does not change: every member shares it.
 */

import { useMemo } from "react";
import { useExchangeStore, selectSelectedMarket } from "@/lib/store";
import { useCompositeOrderbook } from "@/lib/hooks";
import {
  compositeMembers,
  unitClass,
  type CompositeLevel,
} from "@/lib/composite";
import { ChainLogo } from "@/components/ChainLogo";
import { OrderbookRow } from "./OrderbookRow";
import { SpreadIndicator } from "./SpreadIndicator";
import { OrderbookHeader } from "./Orderbook";

/** The tab's label. One place to change it. */
export const COMPOSITE_TAB_LABEL = "Composite";

export function CompositeBook() {
  const markets = useExchangeStore((s) => s.markets);
  const selectedMarket = useExchangeStore(selectSelectedMarket);
  const selectMarket = useExchangeStore((s) => s.selectMarket);
  const setSelectedPrice = useExchangeStore((s) => s.setSelectedPrice);

  const members = useMemo(
    () =>
      selectedMarket
        ? compositeMembers(Object.values(markets), selectedMarket)
        : [],
    [markets, selectedMarket],
  );

  const {
    spread,
    asksWithCumulative,
    bidsWithCumulative,
    maxAskCumulative,
    maxBidCumulative,
  } = useCompositeOrderbook(members);

  if (!selectedMarket) return null;

  if (members.length < 2) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center">
        <p className="text-muted-foreground text-xs">
          {selectedMarket.base_ticker} trades on only one market here, so there
          is nothing to merge.
        </p>
      </div>
    );
  }

  // The base mark is the same icon on every row unless members span more
  // than one base chain; only then does it carry information.
  const showBaseChain =
    new Set(members.map((m) => m.baseChainNetwork)).size > 1;

  const unit = unitClass(selectedMarket.quote_ticker);
  const priceHeader =
    unit === "USD" ? "Price (USD)" : `Price (${selectedMarket.quote_ticker})`;

  const onPick = (level: CompositeLevel) => {
    if (level.marketId !== selectedMarket.id) selectMarket(level.marketId);
    setSelectedPrice(level.priceValue);
  };

  const trailingFor = (level: CompositeLevel) => (
    <>
      {showBaseChain && <ChainLogo network={level.baseChainNetwork} />}
      <ChainLogo network={level.quoteChainNetwork} />
      <span className="text-[10px]">{level.quoteTicker}</span>
    </>
  );

  return (
    <>
      <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] text-muted-foreground/70 border-b border-border/50 shrink-0">
        <span>{members.length} markets</span>
        {members.map((m) => (
          <ChainLogo key={m.id} network={m.quoteChainNetwork} />
        ))}
      </div>
      <OrderbookHeader
        columns={[priceHeader, `Size (${selectedMarket.base_ticker})`, "Chain"]}
      />

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="flex-1 flex flex-col justify-end overflow-hidden">
          <div className="flex flex-col-reverse">
            {asksWithCumulative.map((ask, i) => (
              <OrderbookRow
                key={`${ask.marketId}-${i}`}
                price={ask.priceDisplay}
                priceValue={ask.priceValue}
                size={ask.sizeDisplay}
                cumulative={ask.cumulative}
                maxCumulative={maxAskCumulative}
                type="ask"
                postOnly={ask.postOnly}
                trailing={trailingFor(ask)}
                onClick={() => onPick(ask)}
              />
            ))}
          </div>
        </div>

        <SpreadIndicator spreadPercentage={spread.spreadPercentage} />

        <div className="flex-1 flex flex-col justify-start overflow-hidden">
          <div>
            {bidsWithCumulative.map((bid, i) => (
              <OrderbookRow
                key={`${bid.marketId}-${i}`}
                price={bid.priceDisplay}
                priceValue={bid.priceValue}
                size={bid.sizeDisplay}
                cumulative={bid.cumulative}
                maxCumulative={maxBidCumulative}
                type="bid"
                postOnly={bid.postOnly}
                trailing={trailingFor(bid)}
                onClick={() => onPick(bid)}
              />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
