/**
 * Stub data for development/testing without a backend
 * This module provides hardcoded market data, tokens, and candle generation
 */

import type { Market, Token, Candle } from "./types.js";

// ============================================================================
// TOKENS
// ============================================================================

export const STUB_TOKENS: Token[] = [
  {
    ticker: "BTC",
    decimals: 8,
    name: "Bitcoin",
  },
  {
    ticker: "ETH",
    decimals: 18,
    name: "Ethereum",
  },
  {
    ticker: "USDC",
    decimals: 6,
    name: "USD Coin",
  },
  {
    ticker: "USDT0",
    decimals: 6,
    name: "USDT Zero",
  },
  {
    ticker: "wFLR",
    decimals: 18,
    name: "Wrapped Flare",
  },
  {
    ticker: "FXRP",
    decimals: 18,
    name: "Flare XRP",
  },
];

// ============================================================================
// MARKETS
// ============================================================================

export const STUB_MARKETS: Market[] = [
  {
    id: "BTC/USDC",
    base_ticker: "BTC",
    quote_ticker: "USDC",
    tick_size: "0.01",
    lot_size: "0.0001",
    min_size: "0.0001",
    maker_fee_bps: 10,
    taker_fee_bps: 20,
  },
  {
    id: "ETH/USDC",
    base_ticker: "ETH",
    quote_ticker: "USDC",
    tick_size: "0.01",
    lot_size: "0.001",
    min_size: "0.001",
    maker_fee_bps: 10,
    taker_fee_bps: 20,
  },
  {
    id: "wFLR/USDT0",
    base_ticker: "wFLR",
    quote_ticker: "USDT0",
    tick_size: "0.0001",
    lot_size: "1",
    min_size: "10",
    maker_fee_bps: 10,
    taker_fee_bps: 20,
  },
  {
    id: "FXRP/USDT0",
    base_ticker: "FXRP",
    quote_ticker: "USDT0",
    tick_size: "0.0001",
    lot_size: "1",
    min_size: "10",
    maker_fee_bps: 10,
    taker_fee_bps: 20,
  },
];

// ============================================================================
// CANDLE GENERATION
// ============================================================================

// Base prices for each market (in display units, e.g., $95,000 for BTC)
const BASE_PRICES: Record<string, number> = {
  "BTC/USDC": 95000,
  "ETH/USDC": 3200,
  "wFLR/USDT0": 0.018,
  "FXRP/USDT0": 2.35,
};

// Interval durations in seconds
const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

/**
 * Seeded random number generator for reproducible candle data
 */
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/**
 * Generate realistic OHLCV candle data for a market
 * Returns raw numeric values (not decimal-adjusted)
 */
export function generateCandles(
  marketId: string,
  interval: string,
  from: number,
  to: number,
  countBack?: number,
): Candle[] {
  const basePrice = BASE_PRICES[marketId] ?? 1000;
  const intervalSeconds = INTERVAL_SECONDS[interval] ?? 3600;

  // Calculate number of candles
  let numCandles = Math.floor((to - from) / intervalSeconds);
  if (countBack && countBack < numCandles) {
    numCandles = countBack;
  }
  numCandles = Math.min(numCandles, 1000); // Cap at 1000 candles

  if (numCandles <= 0) {
    return [];
  }

  const candles: Candle[] = [];

  // Use a seed based on marketId and from timestamp for reproducibility
  const seed =
    marketId.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) + from;
  const random = seededRandom(seed);

  // Volatility based on interval (shorter intervals = smaller moves)
  const volatility =
    intervalSeconds < 3600 ? 0.002 : intervalSeconds < 86400 ? 0.005 : 0.015;

  let currentPrice = basePrice;

  // Generate candles from oldest to newest
  const startTime = to - numCandles * intervalSeconds;

  for (let i = 0; i < numCandles; i++) {
    const timestamp = startTime + i * intervalSeconds;

    // Generate OHLC with realistic price movement
    const trend = (random() - 0.48) * volatility; // Slight upward bias
    const range = random() * volatility * 2;

    const open = currentPrice;
    const close = currentPrice * (1 + trend);
    const highExtra = random() * range * currentPrice;
    const lowExtra = random() * range * currentPrice;
    const high = Math.max(open, close) + highExtra;
    const low = Math.min(open, close) - lowExtra;

    // Volume varies randomly (higher volume for lower-priced assets)
    const baseVolume = marketId.includes("BTC")
      ? 50
      : marketId.includes("ETH")
        ? 500
        : 50000;
    const volume = baseVolume * (0.5 + random() * 1.5);

    candles.push({
      time: timestamp * 1000, // TradingView expects milliseconds
      timestamp: timestamp,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(volume * 10000) / 10000,
    });

    currentPrice = close;
  }

  return candles;
}

/**
 * Get token by ticker
 */
export function getToken(ticker: string): Token | undefined {
  return STUB_TOKENS.find((t) => t.ticker === ticker);
}

/**
 * Get market by ID
 */
export function getMarket(marketId: string): Market | undefined {
  return STUB_MARKETS.find((m) => m.id === marketId);
}
