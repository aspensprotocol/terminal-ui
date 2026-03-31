/**
 * Trade adapter - converts protobuf Trade to EnhancedTrade
 */

import type { Trade as ProtoTrade, TradeRole } from "../protos/arborter_pb.js";
import type { EnhancedTrade, Side } from "../types.js";
import { rawToDecimal, formatDecimal } from "./orderbook-adapter.js";

/**
 * Convert TradeRole enum to side string
 * If buyer_is === MAKER (1), then the maker is buying, so the trade side is "buy"
 * If buyer_is === TAKER (2), then the taker is buying, so the trade side is "buy"
 */
function getTradeRole(buyerIs: TradeRole): Side {
  // MAKER = 1, TAKER = 2
  // If buyer_is is MAKER (1) or TAKER (2), the side is "buy"
  // The actual side depends on perspective, but we use the buyer's role to determine
  return "buy"; // Trades are always recorded from buyer's perspective for side
}

/**
 * Determine the trade side based on buyer/seller roles
 */
function getTradeSide(buyerIs: TradeRole, sellerIs: TradeRole): Side {
  // If the taker is the buyer, it's a "buy" market order
  // If the taker is the seller, it's a "sell" market order
  // TAKER = 2
  if (buyerIs === 2) {
    return "buy";
  }
  if (sellerIs === 2) {
    return "sell";
  }
  // Default to buy if unclear
  return "buy";
}

/**
 * Convert a protobuf Trade to an EnhancedTrade
 */
export function toEnhancedTrade(
  trade: ProtoTrade,
  marketId: string,
  pairDecimals: number
): EnhancedTrade {
  const priceValue = rawToDecimal(trade.price, pairDecimals);
  const sizeValue = rawToDecimal(trade.qty, pairDecimals);

  const displayPrice = formatDecimal(priceValue, pairDecimals);
  const displaySize = formatDecimal(sizeValue, pairDecimals);

  // Determine side based on buyer/seller roles
  const side = getTradeSide(trade.buyerIs, trade.sellerIs);

  // Create a unique ID from timestamp and order_hit
  const id = `${trade.timestamp}-${trade.orderHit}`;

  // Convert timestamp from bigint to ISO string
  const timestamp = new Date(Number(trade.timestamp)).toISOString();

  return {
    id,
    market_id: marketId,
    buyer_address: trade.takerBaseAddress || trade.makerBaseAddress,
    seller_address: trade.makerBaseAddress || trade.takerBaseAddress,
    buyer_order_id: trade.orderHit.toString(),
    seller_order_id: trade.makerId,
    price: trade.price,
    size: trade.qty,
    side,
    timestamp,
    priceValue,
    sizeValue,
    displayPrice,
    displaySize,
    priceDisplay: displayPrice,
    sizeDisplay: displaySize,
  };
}

/**
 * Convert an array of protobuf Trades to EnhancedTrades
 */
export function toEnhancedTrades(
  trades: ProtoTrade[],
  marketId: string,
  pairDecimals: number
): EnhancedTrade[] {
  return trades.map((trade) => toEnhancedTrade(trade, marketId, pairDecimals));
}
