/**
 * FCE direct-action transport (Flare Confidential Extension proxy).
 *
 * Drives actions through the ext-proxy (`POST /direct` + poll) instead of gRPC.
 * Transport + envelope codec only — order/withdraw **signing** is unchanged
 * (the same `signatureHash`/`orderId` the gRPC path produces). Reads are
 * one-shot snapshots, not live streams. See `sdk/docs/fce-transport-design.md`.
 */

export { FceClient, type FceClientOptions, type Outcome } from "./proxy.js";
export {
  OP_TYPE_ASPENS,
  OP_COMMAND,
  type OpCommand,
  toBytes32,
  toBytes32Hex,
  buildDirectInstruction,
  bytesToHexBytes,
  hexBytesToBytes,
  hexJsonToObject,
  type DirectInstruction,
} from "./wire.js";
export {
  fceBookToEnhanced,
  fceOpenOrdersToEnhanced,
  fceTradesToEnhanced,
} from "./reads.js";
export {
  decodeConfigEnvelope,
  type GetConfigEnvelope,
  type GetConfigRequest,
} from "./config.js";
export type {
  PlaceOrderRequest,
  PlaceOrderResponse,
  CancelOrderRequest,
  CancelOrderResponse,
  WithdrawRequest,
  WithdrawVoucher,
  GetMyStateRequest,
  GetMyStateResponse,
  OpenOrder,
  GetBookStateRequest,
  GetBookStateResponse,
  BookLevel,
  ExportHistoryRequest,
  ExportHistoryResponse,
  TradeRecord,
} from "./payloads.js";
