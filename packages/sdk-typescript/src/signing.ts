/**
 * Signing utilities for order and cancel requests
 *
 * This module provides utilities for signing protobuf messages
 * for submission to the Arborter backend.
 */

import { create, toBinary } from "@bufbuild/protobuf";
import {
  OrderSchema,
  OrderToCancelSchema,
  Side,
  ExecutionType,
} from "./protos/arborter_pb.js";
import type { Order, OrderToCancel } from "./protos/arborter_pb.js";

import type { TypedDataDefinition } from "viem";

/**
 * Interface for signing adapters (wallet implementations).
 *
 * Wallets always implement `signMessage` for the legacy EIP-191 envelope
 * signature. The gasless flow requires one of the chain-specific methods:
 *
 *  - EVM gasless → `signTypedData` (EIP-712 typed data via wagmi / viem).
 *  - Solana gasless → `signBytes` (raw Ed25519 over borsh payload bytes,
 *    no hex round-trip).
 *
 * Both are optional so legacy adapters keep compiling; the gasless
 * orchestrator throws with a clear error if the required method is
 * missing for the active chain.
 */
export interface SigningAdapter {
  /**
   * Sign a hex-encoded message via EIP-191 / personal_sign (EVM) or
   * raw `signMessage(bytes)` via @solana/wallet-adapter (Solana). The
   * hex round-trip is legacy; for new code prefer `signTypedData` (EVM)
   * or `signBytes` (Solana) via the gasless orchestrator.
   *
   * @param hexMessage The message to sign as a hex string (with 0x prefix)
   * @returns The signature as a hex string (with 0x prefix)
   */
  signMessage(hexMessage: string): Promise<string>;

  /**
   * EVM-only: sign an EIP-712 typed-data digest. Implementations use
   * wagmi's `signTypedData` (which calls `eth_signTypedData_v4` under
   * the hood). Returns the 65-byte ECDSA signature as a 0x-hex string.
   */
  signTypedData?(typedData: TypedDataDefinition): Promise<string>;

  /**
   * Solana-only: sign raw bytes with the wallet's Ed25519 key. Returns
   * the 64-byte signature. No hex round-trip; avoids the ambiguity of
   * signing a hex string vs. the bytes it represents.
   */
  signBytes?(bytes: Uint8Array): Promise<Uint8Array>;
}

/**
 * Order creation parameters for signing
 */
export interface OrderSigningData {
  side: "buy" | "sell";
  quantity: string;
  price?: string;
  marketId: string;
  baseAccountAddress: string;
  quoteAccountAddress: string;
  matchingOrderIds?: number[];
}

/**
 * Cancel order parameters for signing
 */
export interface CancelSigningData {
  marketId: string;
  side: "buy" | "sell";
  tokenAddress: string;
  orderId: string;
}

/**
 * Normalize a wallet signature to the 64-byte wire format the arborter
 * expects. Branches on input length:
 *
 * - **65 bytes** — EVM ECDSA (`r[32] || s[32] || v[1]`). Drop the trailing
 *   recovery byte; arborter recovers the address from message + `r||s`.
 * - **64 bytes** — Solana Ed25519 (already `r||s`). Passthrough.
 * - Anything else — throw. A wallet adapter returned something this code
 *   doesn't know how to hand off; fail loudly rather than ship a bogus
 *   signature that the arborter will silently reject.
 */
export function normalizeWalletSignature(sig: Uint8Array): Uint8Array {
  if (sig.length === 65) return sig.slice(0, 64);
  if (sig.length === 64) return sig;
  throw new Error(
    `unexpected wallet signature length ${sig.length}; expected 65 (EVM ECDSA) or 64 (Solana Ed25519)`,
  );
}

/**
 * Convert a hex string (with or without 0x prefix) to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string with 0x prefix
 */
export function bytesToHex(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Create a protobuf Order message from order data
 */
export function createOrderMessage(data: OrderSigningData): Order {
  return create(OrderSchema, {
    side: data.side === "buy" ? Side.BID : Side.ASK,
    quantity: data.quantity,
    price: data.price,
    marketId: data.marketId,
    baseAccountAddress: data.baseAccountAddress,
    quoteAccountAddress: data.quoteAccountAddress,
    executionType: ExecutionType.UNSPECIFIED,
    matchingOrderIds: data.matchingOrderIds?.map((id) => BigInt(id)) || [],
  });
}

/**
 * Serialize an Order message to bytes for signing
 */
export function serializeOrder(order: Order): Uint8Array {
  return toBinary(OrderSchema, order);
}

/**
 * Create a protobuf OrderToCancel message from cancel data
 */
export function createCancelMessage(data: CancelSigningData): OrderToCancel {
  return create(OrderToCancelSchema, {
    marketId: data.marketId,
    side: data.side === "buy" ? Side.BID : Side.ASK,
    tokenAddress: data.tokenAddress,
    orderId: BigInt(data.orderId),
  });
}

/**
 * Serialize an OrderToCancel message to bytes for signing
 */
export function serializeCancelOrder(order: OrderToCancel): Uint8Array {
  return toBinary(OrderToCancelSchema, order);
}

/**
 * Sign an order using the provided signing adapter
 *
 * @param orderData The order data to sign
 * @param adapter The signing adapter (wallet implementation)
 * @returns The signature as Uint8Array
 */
export async function signOrder(
  orderData: OrderSigningData,
  adapter: SigningAdapter,
): Promise<Uint8Array> {
  // Create the protobuf Order message
  const order = createOrderMessage(orderData);

  // Serialize to bytes
  const protobufBytes = serializeOrder(order);

  // Convert to hex string for signing
  const hexString = bytesToHex(protobufBytes);

  console.log("[Signing] Order bytes hex:", hexString);

  // Sign using the adapter (uses personal_sign under the hood)
  const signature = await adapter.signMessage(hexString);

  console.log("[Signing] Signature received:", signature);

  return normalizeWalletSignature(hexToBytes(signature));
}

/**
 * Sign a cancel order using the provided signing adapter
 *
 * @param cancelData The cancel data to sign
 * @param adapter The signing adapter (wallet implementation)
 * @returns The signature as Uint8Array
 */
export async function signCancelOrder(
  cancelData: CancelSigningData,
  adapter: SigningAdapter,
): Promise<Uint8Array> {
  // Create the protobuf OrderToCancel message
  const order = createCancelMessage(cancelData);

  // Serialize to bytes
  const protobufBytes = serializeCancelOrder(order);

  // Convert to hex string for signing
  const hexString = bytesToHex(protobufBytes);

  console.log("[Signing] Cancel order bytes hex:", hexString);

  // Sign using the adapter
  const signature = await adapter.signMessage(hexString);

  console.log("[Signing] Cancel signature received:", signature);

  return normalizeWalletSignature(hexToBytes(signature));
}

/**
 * Get the protobuf Order object for inspection or manual submission
 */
export function getOrderForSigning(data: OrderSigningData): Order {
  return createOrderMessage(data);
}

/**
 * Get the protobuf OrderToCancel object for inspection or manual submission
 */
export function getCancelOrderForSigning(
  data: CancelSigningData,
): OrderToCancel {
  return createCancelMessage(data);
}
