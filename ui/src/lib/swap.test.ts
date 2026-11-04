/**
 * Swap routing and quoting. Fixture values are chosen so that the wrong
 * side, the wrong book, or skipping the fee each produce a DIFFERENT number
 * — a test whose expected value several bugs would also produce proves
 * nothing.
 */
import { describe, expect, test } from "bun:test";
import type { Market, OrderbookLevel } from "./types/exchange";
import {
  assetKey,
  findRoute,
  quoteSwap,
  receivableAssets,
  swapAssets,
  swapOrderSize,
} from "./swap";

function market(
  id: string,
  base: [string, string],
  quote: [string, string],
): Market {
  return {
    id,
    base_ticker: base[0],
    baseChainNetwork: base[1],
    quote_ticker: quote[0],
    quoteChainNetwork: quote[1],
    tick_size: "0",
    lot_size: "0",
    min_size: "0",
    maker_fee_bps: 0,
    taker_fee_bps: 0,
  };
}

function level(price: number, size: number): OrderbookLevel {
  return {
    price: String(price),
    size: String(size),
    priceValue: price,
    sizeValue: size,
    priceDisplay: String(price),
    sizeDisplay: String(size),
    total: String(price * size),
    displayTotal: String(price * size),
  };
}

const MARKETS = [
  market("m1", ["WETH", "base"], ["USDC", "arbitrum"]),
  // Same tickers on different chains: a distinct market and distinct assets.
  market("m2", ["USDC", "base"], ["USDC", "arbitrum"]),
  market("m3", ["SOL", "solana"], ["USDT", "tron"]),
];

describe("assets and routes", () => {
  test("same ticker on two chains is two assets", () => {
    const keys = swapAssets(MARKETS).map((a) => a.key);
    expect(keys).toContain("USDC@base");
    expect(keys).toContain("USDC@arbitrum");
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(5);
  });

  test("pay base → sell; pay quote → buy", () => {
    const sell = findRoute(MARKETS, "WETH@base", "USDC@arbitrum");
    expect(sell?.market.id).toBe("m1");
    expect(sell?.side).toBe("sell");
    const buy = findRoute(MARKETS, "USDC@arbitrum", "WETH@base");
    expect(buy?.market.id).toBe("m1");
    expect(buy?.side).toBe("buy");
  });

  test("routes on the network, not just the ticker", () => {
    const r = findRoute(MARKETS, "USDC@arbitrum", "USDC@base");
    expect(r?.market.id).toBe("m2");
    expect(r?.side).toBe("buy");
    expect(findRoute(MARKETS, "WETH@arbitrum", "USDC@arbitrum")).toBeNull();
    expect(findRoute(MARKETS, "USDC@base", "USDC@base")).toBeNull();
  });

  test("receivable assets are exactly the one-hop counterparties", () => {
    const keys = receivableAssets(MARKETS, assetKey("USDC", "arbitrum"))
      .map((a) => a.key)
      .sort();
    expect(keys).toEqual(["USDC@base", "WETH@base"]);
  });
});

describe("quoteSwap", () => {
  const bids = [level(2000, 1), level(1900, 2)];
  const asks = [level(2100, 1), level(2200, 2)];

  test("sell walks the bids", () => {
    const q = quoteSwap("sell", 2, bids, 0)!;
    // 1 @ 2000 + 1 @ 1900
    expect(q.receive).toBe(3900);
    expect(q.rate).toBe(1950);
    expect(q.priceImpactPct).toBeCloseTo(2.5, 9);
    expect(q.insufficientLiquidity).toBe(false);
  });

  test("buy spends quote into the asks", () => {
    const q = quoteSwap("buy", 4300, asks, 0)!;
    // 2100 buys 1; remaining 2200 buys 1 more
    expect(q.receive).toBeCloseTo(2, 12);
    expect(q.insufficientLiquidity).toBe(false);
  });

  test("taker fee comes off the received leg", () => {
    const q = quoteSwap("sell", 1, bids, 30)!;
    expect(q.receiveGross).toBe(2000);
    expect(q.fee).toBe(6);
    expect(q.receive).toBe(1994);
  });

  test("flags a book too thin for the amount", () => {
    expect(quoteSwap("sell", 5, bids, 0)!.insufficientLiquidity).toBe(true);
    expect(quoteSwap("buy", 1e6, asks, 0)!.insufficientLiquidity).toBe(true);
  });

  test("no quote without an amount or a book", () => {
    expect(quoteSwap("sell", 0, bids, 0)).toBeNull();
    expect(quoteSwap("sell", 1, [], 0)).toBeNull();
  });
});

describe("swapOrderSize", () => {
  test("sell sizes at the pay amount", () => {
    expect(swapOrderSize("sell", 1.25, null, 8)).toBe("1.25");
    expect(swapOrderSize("sell", 10, null, 8)).toBe("10");
  });

  test("buy sizes at the best ask and never exceeds the pay amount", () => {
    const size = swapOrderSize("buy", 1000, 3, 6)!;
    expect(size).toBe("333.333333");
    expect(Number(size) * 3).toBeLessThanOrEqual(1000);
  });

  test("buy needs a best ask", () => {
    expect(swapOrderSize("buy", 1000, null, 8)).toBeNull();
  });

  test("an amount below one unit of precision is no order", () => {
    expect(swapOrderSize("sell", 0.0000001, null, 4)).toBeNull();
  });
});
