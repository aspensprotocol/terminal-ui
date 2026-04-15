/**
 * Orderbook adapter - converts protobuf OrderbookEntry to EnhancedOrderbookLevel
 */

import type { OrderbookEntry, Side } from "../protos/arborter_pb.js";
import type { EnhancedOrderbookLevel } from "../types.js";

/**
 * Format a value with the specified number of decimal places
 */
function formatDecimal(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

/**
 * Convert a raw integer string to a decimal value
 */
function rawToDecimal(raw: string, decimals: number): number {
  const rawBigInt = BigInt(raw || "0");
  const divisor = BigInt(10 ** decimals);
  const integerPart = rawBigInt / divisor;
  const fractionalPart = rawBigInt % divisor;

  // Combine integer and fractional parts
  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
  return parseFloat(`${integerPart}.${fractionalStr}`);
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
  const totalValue = priceValue * sizeValue;

  const displayPrice = formatDecimal(priceValue, pairDecimals);
  const displaySize = formatDecimal(sizeValue, pairDecimals);
  const displayTotal = formatDecimal(totalValue, pairDecimals);

  return {
    price: entry.price,
    size: entry.quantity,
    priceValue,
    sizeValue,
    displayPrice,
    displaySize,
    priceDisplay: displayPrice,
    sizeDisplay: displaySize,
    total: totalValue.toString(),
    displayTotal,
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

export { rawToDecimal, formatDecimal };
