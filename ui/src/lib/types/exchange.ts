/**
 * Core exchange types, re-exported from the SDK
 */

// Re-export SDK types
export type {
  Market,
  Token,
  Side,
  OrderType,
  OrderStatus,
  // Use enhanced types from SDK
  EnhancedTrade as Trade,
  EnhancedOrder as Order,
  EnhancedBalance as Balance,
  EnhancedOrderbookLevel as OrderbookLevel,
} from "@aspensprotocol/sdk-ts";

// Orderbook composite type - uses enhanced data from SDK
export interface Orderbook {
  market_id: string;
  bids: import("@aspensprotocol/sdk-ts").EnhancedOrderbookLevel[];
  asks: import("@aspensprotocol/sdk-ts").EnhancedOrderbookLevel[];
  timestamp?: number;
}
