/**
 * The composite book merges several markets' books on the adapter's float
 * `priceValue`, never on the raw wire string: each market has its own
 * `pair_decimals`, so raw prices from two members are not comparable. The
 * merge fixture below is built so that ordering by the raw integer gives
 * the OPPOSITE order to ordering by value; a merge that sorts on the wrong
 * field fails it.
 */
import { describe, expect, test } from "bun:test";
import type { Market, OrderbookLevel } from "./types/exchange";
import {
  compositeMembers,
  mergeMemberBooks,
  spreadOf,
  unitClass,
  withCumulative,
} from "./composite";

function market(
  id: string,
  base: string,
  quote: string,
  baseNet: string,
  quoteNet: string,
  pairDecimals: number,
): Market {
  return {
    id,
    base_ticker: base,
    quote_ticker: quote,
    tick_size: "0.01",
    lot_size: "0.01",
    min_size: "0.01",
    maker_fee_bps: 0,
    taker_fee_bps: 0,
    pairDecimals,
    baseChainNetwork: baseNet,
    quoteChainNetwork: quoteNet,
  };
}

/** A level whose raw string and float value are supplied independently. */
function level(
  raw: string,
  priceValue: number,
  sizeValue: number,
): OrderbookLevel {
  return {
    price: raw,
    size: String(sizeValue),
    priceValue,
    sizeValue,
    priceDisplay: String(priceValue),
    sizeDisplay: String(sizeValue),
    total: "0",
    displayTotal: "0",
  };
}

const WETH_USDC_BASE = market(
  "m-usdc-base",
  "WETH",
  "USDC",
  "ethereum-mainnet",
  "base",
  8,
);
const WETH_USDG_RH = market(
  "m-usdg-rh",
  "WETH",
  "USDG",
  "ethereum-mainnet",
  "robinhood",
  6,
);
const WETH_USDC_SOL = market(
  "m-usdc-sol",
  "WETH",
  "USDC",
  "ethereum-mainnet",
  "solana-mainnet",
  6,
);
const WETH_ARB_USDT = market(
  "m-arb-usdt",
  "weth",
  "USDT",
  "arbitrum",
  "op-mainnet",
  8,
);
const WETH_WBTC = market(
  "m-wbtc",
  "WETH",
  "WBTC",
  "ethereum-mainnet",
  "ethereum-mainnet",
  8,
);
const WBTC_USDC = market(
  "m-wbtc-usdc",
  "WBTC",
  "USDC",
  "ethereum-mainnet",
  "base",
  8,
);

describe("unitClass", () => {
  test("USD-pegged stablecoins collapse to USD, case-insensitively", () => {
    expect(unitClass("USDC")).toBe("USD");
    expect(unitClass("usdt")).toBe("USD");
    expect(unitClass("USDG")).toBe("USD");
    expect(unitClass("USDT0")).toBe("USD");
  });

  test("anything else is its own class, uppercased", () => {
    expect(unitClass("WBTC")).toBe("WBTC");
    expect(unitClass("weth")).toBe("WETH");
  });
});

describe("compositeMembers", () => {
  const all = [
    WETH_USDC_BASE,
    WETH_USDG_RH,
    WETH_USDC_SOL,
    WETH_ARB_USDT,
    WETH_WBTC,
    WBTC_USDC,
  ];

  test("same base ticker (any base chain) and like-kind quote, sorted by id, selected included", () => {
    const ids = compositeMembers(all, WETH_USDG_RH).map((m) => m.id);
    expect(ids).toEqual([
      "m-arb-usdt",
      "m-usdc-base",
      "m-usdc-sol",
      "m-usdg-rh",
    ]);
  });

  test("a non-like-kind quote is its own composite", () => {
    expect(compositeMembers(all, WETH_WBTC).map((m) => m.id)).toEqual([
      "m-wbtc",
    ]);
  });

  test("a different base ticker is never a member", () => {
    expect(compositeMembers(all, WBTC_USDC).map((m) => m.id)).toEqual([
      "m-wbtc-usdc",
    ]);
  });
});

describe("mergeMemberBooks", () => {
  test("asks ascend and bids descend by VALUE, not by raw wire integer", () => {
    // Raw integers: A (8 decimals) 150000000000 > B (6 decimals) 1600000000,
    // but as values A = 1500 < B = 1600. Sorting on the raw field would put
    // B's ask first; sorting on value puts A's first.
    const merged = mergeMemberBooks([
      {
        market: WETH_USDC_BASE,
        bids: [level("140000000000", 1400, 1)],
        asks: [level("150000000000", 1500, 1)],
      },
      {
        market: WETH_USDG_RH,
        bids: [level("1450000000", 1450, 1)],
        asks: [level("1600000000", 1600, 1)],
      },
    ]);
    expect(merged.asks.map((l) => l.priceValue)).toEqual([1500, 1600]);
    expect(merged.asks.map((l) => l.marketId)).toEqual([
      "m-usdc-base",
      "m-usdg-rh",
    ]);
    expect(merged.bids.map((l) => l.priceValue)).toEqual([1450, 1400]);
    expect(merged.bids.map((l) => l.marketId)).toEqual([
      "m-usdg-rh",
      "m-usdc-base",
    ]);
  });

  test("every level is tagged with its market's chains and quote ticker, raw price kept verbatim", () => {
    const merged = mergeMemberBooks([
      { market: WETH_USDC_SOL, bids: [], asks: [level("1700000000", 1700, 2)] },
    ]);
    const [ask] = merged.asks;
    expect(ask).toMatchObject({
      marketId: "m-usdc-sol",
      baseChainNetwork: "ethereum-mainnet",
      quoteChainNetwork: "solana-mainnet",
      quoteTicker: "USDC",
      price: "1700000000",
    });
  });

  test("empty members merge to empty sides", () => {
    expect(mergeMemberBooks([])).toEqual({ bids: [], asks: [] });
  });
});

describe("withCumulative", () => {
  test("runs a cumulative size over the first `limit` levels", () => {
    const rows = withCumulative(
      [{ sizeValue: 1 }, { sizeValue: 2 }, { sizeValue: 4 }],
      2,
    );
    expect(rows.map((r) => r.cumulative)).toEqual([1, 3]);
  });
});

describe("spreadOf", () => {
  test("spread is best ask minus best bid, as a percentage of the bid", () => {
    const s = spreadOf([{ priceValue: 1000 }], [{ priceValue: 1010 }]);
    expect(s.spreadValue).toBe(10);
    expect(s.spreadPercentage).toBe("1.00");
  });

  test("an empty side yields zero, not NaN", () => {
    expect(spreadOf([], [{ priceValue: 1010 }])).toEqual({
      spreadValue: 0,
      spreadPercentage: "0.00",
    });
  });
});
