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
  orderId: number;
  orderInBook: boolean;
  fills: number;
}

// ---- CANCEL_ORDER ----

export interface CancelOrderRequest {
  marketId: string;
  side: "BID" | "ASK";
  tokenAddress: string;
  orderId: number;
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
  nonce: number;
  expiry: number;
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
  orderId: number;
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
export interface TradeRecord {
  timestamp: number;
  price: string;
  quantity: string;
  orderHit: number;
}
