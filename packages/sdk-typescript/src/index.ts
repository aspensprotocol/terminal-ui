// Re-export types
export type {
  // API types
  Side,
  OrderType,
  OrderStatus,
  Token,
  Market,
  ApiOrder,
  ApiTrade,
  ApiBalance,
  ApiCandle,
  // Enhanced types
  EnhancedTrade,
  EnhancedOrder,
  EnhancedBalance,
  EnhancedOrderbookLevel,
  Candle,
  // WebSocket types
  SubscriptionChannel,
  PriceLevel,
  OrderbookData,
  TradeData,
  ClientMessage,
  ServerMessage,
} from "./types.js";

// Re-export client
export {
  ExchangeClient,
  type ExchangeClientConfig,
  type CandlesParams,
  type PlaceOrderParams,
  type CancelOrderParams,
  type CancelAllOrdersParams,
} from "./client.js";

// Re-export gRPC transport utilities
export {
  setGrpcBaseUrl,
  getGrpcBaseUrl,
  resetTransport,
} from "./grpc-transport.js";

// Re-export type adapters
export {
  toEnhancedOrderbookLevel,
  toEnhancedOrderbook,
  toEnhancedTrade,
  toEnhancedTrades,
  toMarkets,
  toTokens,
  toChains,
  type ChainInfo,
} from "./adapters/index.js";

// Re-export signing utilities
export {
  signOrder,
  signCancelOrder,
  createOrderMessage,
  createCancelMessage,
  serializeOrder,
  serializeCancelOrder,
  getOrderForSigning,
  getCancelOrderForSigning,
  hexToBytes,
  bytesToHex,
  type SigningAdapter,
  type OrderSigningData,
  type CancelSigningData,
} from "./signing.js";

// Utility functions
import type { Token } from "./types.js";

/**
 * Convert a raw integer value to a display string with decimals
 */
export function toDisplayValue(value: string | number, decimals: number): string {
  if (typeof value === "number") {
    value = value.toString();
  }

  // Handle zero
  if (value === "0") return "0";

  // Handle negative numbers
  const isNegative = value.startsWith("-");
  if (isNegative) {
    value = value.slice(1);
  }

  // Pad with leading zeros if needed
  while (value.length <= decimals) {
    value = "0" + value;
  }

  const intPart = value.slice(0, -decimals) || "0";
  const decPart = value.slice(-decimals);

  // Remove trailing zeros from decimal part
  const trimmedDec = decPart.replace(/0+$/, "");

  const result = trimmedDec ? `${intPart}.${trimmedDec}` : intPart;
  return isNegative ? `-${result}` : result;
}

/**
 * Format a number for display with thousands separators
 * Can be called as:
 *   formatNumber(value)
 *   formatNumber(value, decimals)
 *   formatNumber(value, { decimals, compact })
 */
export function formatNumber(
  value: string | number,
  optionsOrDecimals?: number | { decimals?: number; compact?: boolean }
): string {
  const num = typeof value === "string" ? parseFloat(value) : value;

  if (isNaN(num)) return "0";

  // Normalize options
  const options = typeof optionsOrDecimals === "number"
    ? { decimals: optionsOrDecimals }
    : optionsOrDecimals;

  if (options?.compact && Math.abs(num) >= 1000) {
    const suffixes = ["", "K", "M", "B", "T"];
    const tier = Math.floor(Math.log10(Math.abs(num)) / 3);
    const suffix = suffixes[Math.min(tier, suffixes.length - 1)];
    const scale = Math.pow(10, tier * 3);
    const scaled = num / scale;
    return scaled.toFixed(options.decimals ?? 2) + suffix;
  }

  return num.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: options?.decimals ?? 8,
  });
}

/**
 * Round a value to the nearest tick size
 * Third argument (decimals) is optional for precision control
 */
export function roundToTickSize(value: number, tickSize: string, decimals?: number): number {
  const tick = parseFloat(tickSize);
  if (tick === 0) return value;
  const rounded = Math.round(value / tick) * tick;
  if (decimals !== undefined) {
    const factor = Math.pow(10, decimals);
    return Math.round(rounded * factor) / factor;
  }
  return rounded;
}

/**
 * Round a value to the nearest lot size
 * Third argument (decimals) is optional for precision control
 */
export function roundToLotSize(value: number, lotSize: string, decimals?: number): number {
  const lot = parseFloat(lotSize);
  if (lot === 0) return value;
  const rounded = Math.round(value / lot) * lot;
  if (decimals !== undefined) {
    const factor = Math.pow(10, decimals);
    return Math.round(rounded * factor) / factor;
  }
  return rounded;
}

/**
 * Get the number of decimal places from a value or token
 * Can be called with one or two arguments:
 *   getDecimalPlaces(token)
 *   getDecimalPlaces(tickSize, tokenDecimals)
 */
export function getDecimalPlaces(value: string | number | Token, fallbackDecimals?: number): number {
  if (typeof value === "object" && "decimals" in value) {
    return value.decimals;
  }

  const str = value.toString();
  const decimalIndex = str.indexOf(".");

  // If value has decimal point, count digits after it
  if (decimalIndex !== -1) {
    return str.length - decimalIndex - 1;
  }

  // If no decimal point and fallback provided, use it
  if (fallbackDecimals !== undefined) {
    return fallbackDecimals;
  }

  return 0;
}

export interface CalculatePercentageSizeParams {
  percentage: number;
  side: "buy" | "sell";
  availableBase: number;
  availableQuote: number;
  currentPrice: number;
  market: { lot_size: string };
  baseToken: Token;
}

/**
 * Calculate a percentage of available balance for trading
 * Returns the size as a string formatted for the input
 */
export function calculatePercentageSize(params: CalculatePercentageSizeParams): string {
  const {
    percentage,
    side,
    availableBase,
    availableQuote,
    currentPrice,
    market,
    baseToken,
  } = params;

  let size: number;

  if (side === "sell") {
    // Selling: use percentage of available base token
    size = availableBase * (percentage / 100);
  } else {
    // Buying: use percentage of available quote token divided by price
    const quoteAmount = availableQuote * (percentage / 100);
    size = quoteAmount / currentPrice;
  }

  // Round to lot size
  const lotSize = parseFloat(market.lot_size);
  if (lotSize > 0) {
    size = Math.floor(size / lotSize) * lotSize;
  }

  // Format to appropriate decimal places
  const decimalPlaces = baseToken.decimals;
  return size.toFixed(decimalPlaces);
}
