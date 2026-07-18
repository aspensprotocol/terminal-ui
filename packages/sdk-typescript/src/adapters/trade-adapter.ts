/**
 * Trade adapter - converts protobuf Trade to EnhancedTrade
 */

import type { Trade as ProtoTrade, TradeRole } from "../protos/arborter_pb.js";
import type { EnhancedTrade, Side } from "../types.js";
import { rawToDecimal } from "./orderbook-adapter.js";
import { toDisplayValueCapped } from "../decimals.js";

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
 * Resolve buyer/seller addresses strictly by role. `buyerIs` names WHICH
 * position (maker=1 / taker=2) bought; the other position sold. Never
 * fall back across positions: a redacted hidden side must keep its empty
 * address rather than borrow the visible side's — consumers infer the
 * user's own side by comparing these addresses, and a borrowed address
 * flips that comparison.
 */
function addressesByRole(trade: ProtoTrade): {
  buyer_address: string;
  seller_address: string;
} {
  const takerBought = trade.buyerIs === 2; // TAKER
  return takerBought
    ? {
        buyer_address: trade.takerBaseAddress,
        seller_address: trade.makerBaseAddress,
      }
    : {
        buyer_address: trade.makerBaseAddress,
        seller_address: trade.takerBaseAddress,
      };
}

/**
 * Convert a protobuf Trade to an EnhancedTrade
 */
export function toEnhancedTrade(
  trade: ProtoTrade,
  marketId: string,
  pairDecimals: number,
): EnhancedTrade {
  const priceValue = rawToDecimal(trade.price, pairDecimals);
  const sizeValue = rawToDecimal(trade.qty, pairDecimals);

  const displayPrice = toDisplayValueCapped(trade.price, pairDecimals);
  const displaySize = toDisplayValueCapped(trade.qty, pairDecimals);

  // Determine side based on buyer/seller roles
  const side = getTradeSide(trade.buyerIs, trade.sellerIs);

  // Unique-enough stable id. orderHit alone stopped sufficing once
  // redaction zeroed it for hidden fills (`${ts}-0` collided); price+qty
  // disambiguate all but byte-identical simultaneous redacted fills.
  // Do NOT add a positional index — ids must be stable across polls or
  // the store double-counts trades.
  const id = `${trade.timestamp}-${trade.orderHit}-${trade.price}-${trade.qty}`;

  const { buyer_address, seller_address } = addressesByRole(trade);

  // Convert timestamp from bigint to ISO string
  const timestamp = new Date(Number(trade.timestamp)).toISOString();

  return {
    id,
    market_id: marketId,
    buyer_address,
    seller_address,
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
  pairDecimals: number,
): EnhancedTrade[] {
  return trades.map((trade) => toEnhancedTrade(trade, marketId, pairDecimals));
}
