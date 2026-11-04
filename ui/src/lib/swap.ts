/**
 * Swap = a market order on whichever market pairs the two assets.
 *
 * The swap page shows "pay asset A on chain X, receive asset B on chain Y";
 * the venue only knows markets. An asset here is a (ticker, network) pair —
 * the same ticker on two chains is two assets, which is the whole point of a
 * cross-chain swap. A pair resolves to a market and a side:
 *
 * - market.base = pay, market.quote = receive → SELL, size = pay amount
 * - market.base = receive, market.quote = pay → BUY, size in base, sized so
 *   its quote budget (size × best ask) never exceeds the pay amount
 *
 * Quotes walk the live book. They are an estimate: the order is a market
 * order, so it fills against whatever rests when it matches.
 */
import type { Market, OrderbookLevel } from "./types/exchange";

export interface SwapAsset {
  /** Stable key: `${ticker}@${network}`. */
  key: string;
  ticker: string;
  network: string;
}

export interface SwapRoute {
  market: Market;
  side: "buy" | "sell";
}

export function assetKey(ticker: string, network: string): string {
  return `${ticker}@${network}`;
}

function legAsset(ticker: string, network: string | undefined): SwapAsset {
  const net = network ?? "";
  return { key: assetKey(ticker, net), ticker, network: net };
}

/** Every distinct asset that appears on either leg of any market. */
export function swapAssets(markets: Market[]): SwapAsset[] {
  const seen = new Map<string, SwapAsset>();
  for (const m of markets) {
    for (const a of [
      legAsset(m.base_ticker, m.baseChainNetwork),
      legAsset(m.quote_ticker, m.quoteChainNetwork),
    ]) {
      if (!seen.has(a.key)) seen.set(a.key, a);
    }
  }
  return [...seen.values()];
}

/** The market and side that turn `pay` into `receive`, if any market pairs them. */
export function findRoute(
  markets: Market[],
  payKey: string,
  receiveKey: string,
): SwapRoute | null {
  if (payKey === receiveKey) return null;
  for (const market of markets) {
    const base = assetKey(market.base_ticker, market.baseChainNetwork ?? "");
    const quote = assetKey(market.quote_ticker, market.quoteChainNetwork ?? "");
    if (base === payKey && quote === receiveKey)
      return { market, side: "sell" };
    if (base === receiveKey && quote === payKey) return { market, side: "buy" };
  }
  return null;
}

/** Assets reachable from `payKey` through a single market. */
export function receivableAssets(
  markets: Market[],
  payKey: string,
): SwapAsset[] {
  return swapAssets(markets).filter(
    (a) => findRoute(markets, payKey, a.key) !== null,
  );
}

export interface SwapQuote {
  /** What the user receives after the taker fee. */
  receive: number;
  /** Receive before the fee. */
  receiveGross: number;
  /** Fee, in the received asset (taker pays on the received leg). */
  fee: number;
  /** Receive-asset per one pay-asset, at the volume-weighted fill. */
  rate: number;
  /** How much worse the average fill is than the top of book, in percent. */
  priceImpactPct: number;
  /** The book could not absorb the whole pay amount. */
  insufficientLiquidity: boolean;
}

/**
 * Walk the book for `payAmount` of the pay asset.
 *
 * Sell: pay base into the bids (best first). Buy: spend quote into the asks
 * (best first). Levels are assumed sorted best-first, as the store holds them.
 */
export function quoteSwap(
  side: "buy" | "sell",
  payAmount: number,
  levels: OrderbookLevel[],
  takerFeeBps: number,
): SwapQuote | null {
  if (!(payAmount > 0) || levels.length === 0) return null;
  const top = levels[0]!.priceValue;
  if (!(top > 0)) return null;

  let remaining = payAmount;
  let receiveGross = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const { priceValue: price, sizeValue: size } = level;
    if (!(price > 0) || !(size > 0)) continue;
    if (side === "sell") {
      const take = Math.min(remaining, size);
      receiveGross += take * price;
      remaining -= take;
    } else {
      const take = Math.min(remaining / price, size);
      receiveGross += take;
      remaining -= take * price;
    }
  }

  // Float dust from the subtraction above is not a shortfall.
  const insufficientLiquidity = remaining > payAmount * 1e-9;
  const filledPay = payAmount - Math.max(remaining, 0);
  const fee = (receiveGross * takerFeeBps) / 10_000;
  const receive = receiveGross - fee;
  const rate = filledPay > 0 ? receiveGross / filledPay : 0;
  const topRate = side === "sell" ? top : 1 / top;
  const priceImpactPct = topRate > 0 ? ((topRate - rate) / topRate) * 100 : 0;

  return {
    receive,
    receiveGross,
    fee,
    rate,
    priceImpactPct: Math.max(priceImpactPct, 0),
    insufficientLiquidity,
  };
}

/**
 * The order size (always in base) for a swap of `payAmount`, as a decimal
 * string truncated — never rounded up — to `decimals` places.
 *
 * A buy sizes at the best ask, so the quote budget the submit path derives
 * (size × best ask) is at most `payAmount`: the swap never commits more than
 * the user typed. Truncation keeps that true after the float division.
 */
export function swapOrderSize(
  side: "buy" | "sell",
  payAmount: number,
  bestAsk: number | null,
  decimals: number,
): string | null {
  if (!(payAmount > 0)) return null;
  let size = payAmount;
  if (side === "buy") {
    if (!bestAsk || !(bestAsk > 0)) return null;
    size = payAmount / bestAsk;
  }
  const dp = Math.min(Math.max(decimals, 0), 12);
  const scale = 10 ** dp;
  const truncated = Math.floor(size * scale) / scale;
  if (!(truncated > 0)) return null;
  const fixed = truncated.toFixed(dp);
  return dp > 0 ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
