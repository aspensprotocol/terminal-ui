/**
 * Orderbook adapter - converts protobuf OrderbookEntry to EnhancedOrderbookLevel
 *
 * Wire format: `price` and `quantity` arrive as decimal-string integers scaled
 * by `pairDecimals` (e.g. "1500000" with pairDecimals=6 means 1.5). Display
 * strings are produced via `toDisplayValueCapped` so trailing zeros don't
 * pollute the UI when pairDecimals is large.
 */

import type { OrderbookEntry } from "../protos/arborter_pb.js";
import type { EnhancedOrderbookLevel } from "../types.js";
import { toDisplayValue, toDisplayValueCapped } from "../decimals.js";

/**
 * Convert a raw scaled-integer string to a JS number.
 *
 * Goes through the exact `toDisplayValue` string so we don't lose precision
 * during the BigInt → Number cast for values larger than 2^53.
 */
function rawToDecimal(raw: string, decimals: number): number {
  return parseFloat(toDisplayValue(raw || "0", decimals));
}

/**
 * Multiply two scaled-integer strings (both in `pairDecimals` units) and
 * return the product re-scaled back to `pairDecimals` units. Uses BigInt so
 * the intermediate `price * size` doesn't overflow / lose precision.
 */
function multiplyScaled(a: string, b: string, pairDecimals: number): string {
  const product = BigInt(a || "0") * BigInt(b || "0");
  const divisor = BigInt(10) ** BigInt(pairDecimals);
  return (product / divisor).toString();
}

/**
 * Convert a protobuf OrderbookEntry to an EnhancedOrderbookLevel
 */
export function toEnhancedOrderbookLevel(
  entry: OrderbookEntry,
  pairDecimals: number,
): EnhancedOrderbookLevel {
  const priceValue = rawToDecimal(entry.price, pairDecimals);
  const sizeValue = rawToDecimal(entry.quantity, pairDecimals);

  const displayPrice = toDisplayValueCapped(entry.price, pairDecimals);
  const displaySize = toDisplayValueCapped(entry.quantity, pairDecimals);

  const totalRaw = multiplyScaled(entry.price, entry.quantity, pairDecimals);
  const displayTotal = toDisplayValueCapped(totalRaw, pairDecimals);

  return {
    price: entry.price,
    size: entry.quantity,
    priceValue,
    sizeValue,
    displayPrice,
    displaySize,
    priceDisplay: displayPrice,
    sizeDisplay: displaySize,
    total: totalRaw,
    displayTotal,
    postOnly: entry.postOnly,
  };
}

/**
 * Convert an array of protobuf OrderbookEntries to Enhanced levels,
 * separated into bids and asks
 */
export function toEnhancedOrderbook(
  entries: OrderbookEntry[],
  pairDecimals: number,
): { bids: EnhancedOrderbookLevel[]; asks: EnhancedOrderbookLevel[] } {
  const bids: EnhancedOrderbookLevel[] = [];
  const asks: EnhancedOrderbookLevel[] = [];

  for (const entry of entries) {
    const enhanced = toEnhancedOrderbookLevel(entry, pairDecimals);

    // Side enum: BID = 1, ASK = 2
    if (entry.side === 1) {
      bids.push(enhanced);
    } else if (entry.side === 2) {
      asks.push(enhanced);
    }
  }

  // Sort bids descending by price (highest first)
  bids.sort((a, b) => b.priceValue - a.priceValue);

  // Sort asks ascending by price (lowest first)
  asks.sort((a, b) => a.priceValue - b.priceValue);

  return { bids, asks };
}

export { rawToDecimal };
