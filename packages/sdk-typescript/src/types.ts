// Hand-maintained TypeScript types layered over the protobuf bindings in
// `./protos/` — extend or reshape proto-derived fields for the UI.

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
export type OrderStatus =
  | "pending"
  | "filled"
  | "partially_filled"
  | "cancelled";

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
  /** Chain architecture of the base chain, e.g. "EVM", "Solana", "Hedera". */
  baseChainArchitecture?: string;
  /** Chain architecture of the quote chain, e.g. "EVM", "Solana", "Hedera". */
  quoteChainArchitecture?: string;
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
  /**
   * Locally-known hidden flag. True only for orders this client placed
   * with `hidden: true` — the backend never echoes hidden orders in any
   * stream, so this cannot be learned from server data after the fact.
   */
  hidden?: boolean;
  filled_size: string;
  created_at: string;
  updated_at: string;
  /**
   * The order's per-chain account addresses as the venue holds them —
   * base-chain wallet and quote-chain wallet — in the server's canonical
   * form (EVM lowercased hex, base58 byte-exact). A cancel must be signed
   * by the wallet on the order's LOCK leg: the quote wallet for a buy, the
   * base wallet for a sell. Absent on reads that do not carry them (the
   * FCE state read), in which case a caller can only fall back to the lock
   * leg's ecosystem.
   */
  base_account_address?: string;
  quote_account_address?: string;
}

export interface ApiTrade {
  id: string;
  market_id: string;
  buyer_address: string;
  seller_address: string;
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
  priceDisplay: string;
  sizeDisplay: string;
}

export interface EnhancedOrder extends ApiOrder {
  // Numeric values for calculations
  priceValue: number;
  sizeValue: number;
  filledValue: number;
  // Display strings
  priceDisplay: string;
  sizeDisplay: string;
  filledDisplay: string;
  // Related trades from order placement
  trades?: ApiTrade[];
}

/**
 * A user's balance in one token, aggregated across every chain it lives on.
 *
 * `amount` is what the trade contract holds — the whole of it. There is no
 * locked/available split: order collateral is reserved off-chain in the TEE
 * and is not observable from the chain, so a split derived from on-chain reads
 * could only ever be `amount` and a constant zero.
 */
export interface EnhancedBalance {
  user_address: string;
  token_ticker: string;
  /** Raw scaled integer, at the token's decimals. */
  amount: string;
  updated_at: string;
  /** Float companion to `amount`, for sorting and display math. */
  amountValue: number;
  displayAmount: string;
  amountDisplay: string;
}

export interface EnhancedOrderbookLevel {
  price: string;
  size: string;
  // Numeric values for calculations
  priceValue: number;
  sizeValue: number;
  // Display strings
  priceDisplay: string;
  sizeDisplay: string;
  total: string;
  displayTotal: string;
  /**
   * Resting order is post-only — guaranteed not to take liquidity. Mirrors
   * the `post_only` flag on the `OrderbookEntry` proto. Optional because
   * pre-feature snapshots / streams may not set it (proto3 default is
   * false, so unknown ≡ false in practice).
   */
  postOnly?: boolean;
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

// Subscription message shapes. The SDK has no WebSocket transport and nothing
// sends or receives these; the client's `on*` hooks poll gRPC streams.

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
      amount: string;
      updated_at: number;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "pong";
    };
