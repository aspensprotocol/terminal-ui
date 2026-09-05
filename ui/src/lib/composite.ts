/**
 * The composite orderbook: one merged view over every market that trades
 * the selected market's base token against a like-kind quote.
 *
 * The venue keeps one book per market id and nothing on the wire groups
 * markets, so membership and the merge are decided here, on the client.
 * Levels are merged on the adapter's float `priceValue`: each market has
 * its own `pair_decimals`, so the raw wire price strings of two members
 * are not comparable and are carried through untouched, per row.
 */

import type { Market, OrderbookLevel } from "@/lib/types/exchange";

/**
 * Quote tickers the composite treats as one unit of account. A price in
 * any of these is shown on the same axis. Curated, not derived: the venue
 * does not tag tokens, and a de-pegged member would show as a "cheap" base
 * token — which is why every row keeps its own quote ticker visible.
 */
const USD_STABLE_TICKERS: ReadonlySet<string> = new Set([
  "USDC",
  "USDT",
  "USDT0",
  "USDG",
  "USDE",
  "USDS",
  "USD1",
  "DAI",
  "FDUSD",
  "PYUSD",
  "TUSD",
]);

/** The unit-of-account class a quote ticker prices in: "USD" or itself. */
export function unitClass(ticker: string): string {
  const upper = ticker.toUpperCase();
  return USD_STABLE_TICKERS.has(upper) ? "USD" : upper;
}

/**
 * Every market sharing `selected`'s base ticker (on any base chain) whose
 * quote is in the same unit class, sorted by id for a stable order.
 * `selected` is always a member of its own composite.
 */
export function compositeMembers(
  markets: Market[],
  selected: Market,
): Market[] {
  const base = selected.base_ticker.toUpperCase();
  const unit = unitClass(selected.quote_ticker);
  return markets
    .filter(
      (m) =>
        m.base_ticker.toUpperCase() === base &&
        unitClass(m.quote_ticker) === unit,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A level plus the identity of the market it rests on. */
export interface CompositeLevel extends OrderbookLevel {
  marketId: string;
  baseChainNetwork?: string;
  quoteChainNetwork?: string;
  quoteTicker: string;
}

export interface MemberBook {
  market: Market;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

/** Merge member books: bids descending, asks ascending, by `priceValue`. */
export function mergeMemberBooks(books: MemberBook[]): {
  bids: CompositeLevel[];
  asks: CompositeLevel[];
} {
  const tag = (market: Market, l: OrderbookLevel): CompositeLevel => ({
    ...l,
    marketId: market.id,
    baseChainNetwork: market.baseChainNetwork,
    quoteChainNetwork: market.quoteChainNetwork,
    quoteTicker: market.quote_ticker,
  });
  const bids = books.flatMap((b) => b.bids.map((l) => tag(b.market, l)));
  const asks = books.flatMap((b) => b.asks.map((l) => tag(b.market, l)));
  bids.sort((a, b) => b.priceValue - a.priceValue);
  asks.sort((a, b) => a.priceValue - b.priceValue);
  return { bids, asks };
}

/** The first `limit` levels with a running size total, for depth bars. */
export function withCumulative<T extends { sizeValue: number }>(
  levels: T[],
  limit = 15,
): Array<T & { cumulative: number }> {
  let running = 0;
  return levels.slice(0, limit).map((l) => {
    running += l.sizeValue;
    return { ...l, cumulative: running };
  });
}

/** Best ask minus best bid, and that as a percentage of the best bid. */
export function spreadOf(
  bids: { priceValue: number }[],
  asks: { priceValue: number }[],
): { spreadValue: number; spreadPercentage: string } {
  const lowestAsk = asks[0]?.priceValue ?? 0;
  const highestBid = bids[0]?.priceValue ?? 0;
  const spreadValue = lowestAsk && highestBid ? lowestAsk - highestBid : 0;
  const spreadPercentage = highestBid
    ? ((spreadValue / highestBid) * 100).toFixed(2)
    : "0.00";
  return { spreadValue, spreadPercentage };
}
