// API Types (from openapi.json)

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
export type OrderStatus = "pending" | "filled" | "partially_filled" | "cancelled";

export interface Token {
  ticker: string;
  decimals: number;
  name: string;
  // Extended fields from gRPC config
  address?: string;
  chainNetwork?: string;
}

export interface Market {
  id: string;
  base_ticker: string;
  quote_ticker: string;
  tick_size: string;
  lot_size: string;
  min_size: string;
  maker_fee_bps: number;
  taker_fee_bps: number;
  // Extended fields from gRPC config
  pairDecimals?: number;
  baseChainNetwork?: string;
  quoteChainNetwork?: string;
  baseChainTokenDecimals?: number;
  quoteChainTokenDecimals?: number;
  name?: string;
}

export interface ApiOrder {
  id: string;
  user_address: string;
  market_id: string;
  price: string;
  size: string;
  side: Side;
  order_type: OrderType;
  status: OrderStatus;
  filled_size: string;
  created_at: string;
  updated_at: string;
}

export interface ApiTrade {
  id: string;
  market_id: string;
  buyer_address: string;
  seller_address: string;
  buyer_order_id: string;
  seller_order_id: string;
  price: string;
  size: string;
  side: Side;
  timestamp: string;
}

export interface ApiBalance {
  user_address: string;
  token_ticker: string;
  amount: string;
  open_interest: string;
  updated_at: string;
}

export interface ApiCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Enhanced types with display values (numeric for calculations, string for display)
export interface EnhancedTrade extends ApiTrade {
  // Numeric values for calculations
  priceValue: number;
  sizeValue: number;
  // Display strings
  displayPrice: string;
  displaySize: string;
  priceDisplay: string;
  sizeDisplay: string;
}

export interface EnhancedOrder extends ApiOrder {
  // Numeric values for calculations
  priceValue: number;
  sizeValue: number;
  filledValue: number;
  // Display strings
  displayPrice: string;
  displaySize: string;
  displayFilledSize: string;
  priceDisplay: string;
  sizeDisplay: string;
  filledDisplay: string;
  // Related trades from order placement
  trades?: ApiTrade[];
}

export interface EnhancedBalance {
  user_address: string;
  token_ticker: string;
  amount: string;
  open_interest: string;
  locked: string;
  updated_at: string;
  // Numeric values for calculations
  amountValue: number;
  lockedValue: number;
  // Display strings
  displayAmount: string;
  displayOpenInterest: string;
  amountDisplay: string;
  available: string;
  displayAvailable: string;
}

export interface EnhancedOrderbookLevel {
  price: string;
  size: string;
  // Numeric values for calculations
  priceValue: number;
  sizeValue: number;
  // Display strings
  displayPrice: string;
  displaySize: string;
  priceDisplay: string;
  sizeDisplay: string;
  total: string;
  displayTotal: string;
}

// Candle type alias for charting
export interface Candle {
  time: number;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// WebSocket Types (from websocket.json)

export type SubscriptionChannel =
  | "trades"
  | "orderbook"
  | "user_fills"
  | "user_orders"
  | "user_balances";

export interface PriceLevel {
  price: string;
  size: string;
}

export interface OrderbookData {
  market_id: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export interface TradeData {
  id: string;
  market_id: string;
  buyer_address: string;
  seller_address: string;
  buyer_order_id: string;
  seller_order_id: string;
  price: string;
  size: string;
  side: Side;
  timestamp: number;
}

// Client Messages
export type ClientMessage =
  | {
      type: "subscribe";
      channel: SubscriptionChannel;
      market_id?: string | null;
      user_address?: string | null;
    }
  | {
      type: "unsubscribe";
      channel: SubscriptionChannel;
      market_id?: string | null;
      user_address?: string | null;
    }
  | {
      type: "ping";
    };

// Server Messages
export type ServerMessage =
  | {
      type: "subscribed";
      channel: SubscriptionChannel;
      market_id?: string | null;
      user_address?: string | null;
    }
  | {
      type: "unsubscribed";
      channel: SubscriptionChannel;
      market_id?: string | null;
      user_address?: string | null;
    }
  | {
      type: "trade";
      trade: TradeData;
    }
  | {
      type: "orderbook";
      orderbook: OrderbookData;
    }
  | {
      type: "candle";
      market_id: string;
      timestamp: number;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }
  | {
      type: "user_fill";
      trade: TradeData;
    }
  | {
      type: "user_order";
      order_id: string;
      status: string;
      filled_size: string;
    }
  | {
      type: "user_balance";
      user_address: string;
      token_ticker: string;
      available: string;
      locked: string;
      updated_at: number;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "pong";
    };
