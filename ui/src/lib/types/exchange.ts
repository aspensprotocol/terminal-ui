/**
 * Core exchange types - now imported from SDK
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
} from "@aspens/terminal-sdk";

// Orderbook composite type - uses enhanced data from SDK
export interface Orderbook {
  market_id: string;
  bids: import("@aspens/terminal-sdk").EnhancedOrderbookLevel[];
  asks: import("@aspens/terminal-sdk").EnhancedOrderbookLevel[];
  timestamp?: number;
}
