/**
 * u64 fields cross this wire as QUOTED STRINGS, never bare numbers.
 *
 * JSON.parse rounds any integer above 2^53, because JS numbers are doubles.
 * That silently broke cancel in production: the arborter held order
 * 173852891691592598, the browser read 173852891691592600, sent it back, and
 * find_order missed — the order stayed in the book with its collateral
 * reserved. Keep these as strings end to end; convert with BigInt only where
 * arithmetic is genuinely needed, never via Number().
 *
 * Matches the Go side's types.U64String and proto3's JSON mapping for 64-bit
 * integers, and the u128 amounts that were already strings here.
 */
/**
 * Direct-action request/response payloads — the JSON that rides in
 * `DirectInstruction.message`. Field-for-field with the adapter's
 * `extension/pkg/types/types.go` (camelCase; u128 decimal-string amounts;
 * `signatureHash`/`signature` as `0x`-hex). Mirrors the Rust `aspens::fce::payloads`.
 */

import type { Hex } from "viem";

// ---- PLACE_ORDER ----

export interface PlaceOrderRequest {
  side: "BID" | "ASK";
  quantity: string;
  /** omit for a MARKET order */
  price?: string;
  marketId: string;
  baseAccountAddress: string;
  quoteAccountAddress: string;
  /** "DIRECT" | "DISCRETIONARY"; omit for DIRECT */
  executionType?: string;
  /** omit when false (Go omitempty) */
  postOnly?: boolean;
  /** EIP-712 order signature, 0x-hex */
  signatureHash: Hex;
  /** SDK-derived canonical order id */
  orderId: string;
  /** committed lock, u128 decimal */
  amountIn: string;
}

export interface PlaceOrderResponse {
  orderId: string;
  orderInBook: boolean;
  fills: number;
}

// ---- CANCEL_ORDER ----

export interface CancelOrderRequest {
  marketId: string;
  side: "BID" | "ASK";
  tokenAddress: string;
  orderId: string;
  signatureHash: Hex;
}

export interface CancelOrderResponse {
  canceled: boolean;
}

// ---- WITHDRAW (direct action → MidribV3 voucher) ----

export interface WithdrawRequest {
  network: string;
  token: string;
  account: string;
  amount: string;
  /** signature over `network|token|account|amount`, 0x-hex */
  signature: Hex;
}

export interface WithdrawVoucher {
  account: string;
  token: string;
  amount: string;
  nonce: string;
  expiry: string;
  signature: Hex;
}

// ---- Direct reads (one-shot snapshots; NOT live streams) ----

export interface GetMyStateRequest {
  marketId: string;
  trader: string;
}
export interface GetMyStateResponse {
  openOrders: OpenOrder[];
}
export interface OpenOrder {
  orderId: string;
  marketId: string;
  side: string;
  price: string;
  quantity: string;
  state: string;
}

export interface GetBookStateRequest {
  marketId: string;
  /** cap per side (0 => default) */
  depth: number;
}
export interface GetBookStateResponse {
  marketId: string;
  bids: BookLevel[];
  asks: BookLevel[];
}
export interface BookLevel {
  price: string;
  quantity: string;
}

export interface ExportHistoryRequest {
  marketId: string;
  trader: string;
}
export interface ExportHistoryResponse {
  trades: TradeRecord[];
}
/**
 * Mirrors the adapter's `types.TradeRecord`. The role and address fields are
 * NOT derivable client-side: without `buyerIs`/`sellerIs` there is no way to
 * tell a buy from a sell, and without the addresses no way to attribute a fill
 * to a user. A hidden side arrives already redacted (empty addresses) — keep it
 * empty rather than substituting the visible side's.
 */
export interface TradeRecord {
  timestamp: string;
  price: string;
  quantity: string;
  orderHit: string;
  /** "MAKER" | "TAKER" | "" — "" when the arborter left the role unset. */
  buyerIs: string;
  sellerIs: string;
  makerBaseAddress: string;
  makerQuoteAddress: string;
  takerBaseAddress: string;
  takerQuoteAddress: string;
}
