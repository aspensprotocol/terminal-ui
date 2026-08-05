/**
 * FCE read adapters — `/direct` snapshot payloads → the enhanced shapes the
 * gRPC path produces, so consumers are transport-agnostic.
 *
 * These exist because the FCE payloads differ in shape from the gRPC stream:
 * the book arrives pre-aggregated per price level rather than per order, and
 * open orders/trades arrive as flat records. A silent mismatch here surfaces as
 * a mis-coloured tape or a mis-attributed fill rather than as an error, which
 * is why each mapping below is pinned by a test.
 */

import type {
  ExportHistoryResponse,
  GetBookStateResponse,
  GetMyStateResponse,
} from "./payloads.js";
import { rawToDecimal } from "../adapters/orderbook-adapter.js";
import { toDisplayValueCapped } from "../decimals.js";
import type {
  EnhancedOrder,
  EnhancedOrderbookLevel,
  EnhancedTrade,
  OrderType,
  Side,
} from "../types.js";

function level(
  price: string,
  quantity: string,
  pairDecimals: number,
): EnhancedOrderbookLevel {
  const priceValue = rawToDecimal(price, pairDecimals);
  const sizeValue = rawToDecimal(quantity, pairDecimals);
  const displayPrice = toDisplayValueCapped(price, pairDecimals);
  const displaySize = toDisplayValueCapped(quantity, pairDecimals);
  // The FCE book carries no per-order flags, so `total` is computed here from
  // the level itself rather than borrowed from an order.
  const totalValue = priceValue * sizeValue;
  return {
    price,
    size: quantity,
    priceValue,
    sizeValue,
    displayPrice,
    displaySize,
    priceDisplay: displayPrice,
    sizeDisplay: displaySize,
    total: totalValue.toString(),
    displayTotal: totalValue.toFixed(pairDecimals),
    postOnly: false,
  };
}

/**
 * GET_BOOK_STATE levels are already aggregated per price, so unlike the gRPC
 * path there is nothing to group. Zero-quantity levels are consumed price
 * points, not depth, and are dropped.
 */
export function fceBookToEnhanced(
  resp: GetBookStateResponse,
  pairDecimals: number,
): { bids: EnhancedOrderbookLevel[]; asks: EnhancedOrderbookLevel[] } {
  const live = (l: { price: string; quantity: string }) => l.quantity !== "0";
  return {
    bids: (resp.bids ?? [])
      .filter(live)
      .map((l) => level(l.price, l.quantity, pairDecimals)),
    asks: (resp.asks ?? [])
      .filter(live)
      .map((l) => level(l.price, l.quantity, pairDecimals)),
  };
}

/**
 * GET_MY_STATE is already scoped to one trader, so `user_address` is the
 * address that was queried — the payload carries no per-order address.
 *
 * The payload also carries no timestamp; `created_at`/`updated_at` are stamped
 * at receipt. Sorting by them is therefore unstable across polls — sort by
 * `id` if a stable order matters.
 */
export function fceOpenOrdersToEnhanced(
  resp: GetMyStateResponse,
  marketId: string,
  userAddress: string,
  pairDecimals: number,
): EnhancedOrder[] {
  const now = new Date().toISOString();
  return (resp.openOrders ?? []).map((o) => {
    const priceValue = rawToDecimal(o.price, pairDecimals);
    const sizeValue = rawToDecimal(o.quantity, pairDecimals);
    const displayPrice = toDisplayValueCapped(o.price, pairDecimals);
    const displaySize = toDisplayValueCapped(o.quantity, pairDecimals);
    return {
      id: String(o.orderId),
      user_address: userAddress,
      market_id: o.marketId || marketId,
      price: o.price,
      size: o.quantity,
      side: (o.side === "BID" ? "buy" : "sell") as Side,
      order_type: "limit" as OrderType,
      status: "pending" as const,
      filled_size: "0",
      created_at: now,
      updated_at: now,
      priceValue,
      sizeValue,
      filledValue: 0,
      displayPrice,
      displaySize,
      displayFilledSize: "0",
      priceDisplay: displayPrice,
      sizeDisplay: displaySize,
      filledDisplay: "0",
    };
  });
}

/**
 * Side and the buyer/seller addresses come from the ROLES, never from position.
 *
 * `buyerIs` names which position (MAKER/TAKER) bought; the other sold. A
 * redacted hidden side arrives with empty addresses and must STAY empty —
 * borrowing the visible side's would flip the "is this my fill?" comparison
 * consumers make, attributing someone else's trade to the user. An unset role
 * yields empty addresses rather than a guessed side, because a wrong side
 * inverts the colour of the row.
 */
export function fceTradesToEnhanced(
  resp: ExportHistoryResponse,
  marketId: string,
  pairDecimals: number,
): EnhancedTrade[] {
  return (resp.trades ?? []).map((t) => {
    const takerBought = t.buyerIs === "TAKER";
    const takerSold = t.sellerIs === "TAKER";
    const known = takerBought || takerSold;

    const buyer_address = takerBought
      ? t.takerBaseAddress
      : takerSold
        ? t.makerBaseAddress
        : "";
    const seller_address = takerBought
      ? t.makerBaseAddress
      : takerSold
        ? t.takerBaseAddress
        : "";

    const priceValue = rawToDecimal(t.price, pairDecimals);
    const sizeValue = rawToDecimal(t.quantity, pairDecimals);
    const displayPrice = toDisplayValueCapped(t.price, pairDecimals);
    const displaySize = toDisplayValueCapped(t.quantity, pairDecimals);

    return {
      id: `${t.timestamp}-${t.orderHit}`,
      market_id: marketId,
      buyer_address,
      seller_address,
      buyer_order_id: "",
      seller_order_id: "",
      price: t.price,
      size: t.quantity,
      // Only the taker's direction is meaningful; default to "buy" when the
      // role is unset, matching the gRPC adapter's own fallback.
      side: (known && takerSold ? "sell" : "buy") as Side,
      timestamp: new Date(Number(t.timestamp)).toISOString(),
      priceValue,
      sizeValue,
      displayPrice,
      displaySize,
      priceDisplay: displayPrice,
      sizeDisplay: displaySize,
    };
  });
}
