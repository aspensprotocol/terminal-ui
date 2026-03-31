/**
 * Signing utilities for order and cancel requests
 *
 * This module provides utilities for signing protobuf messages
 * for submission to the Arborter backend.
 */

import { create, toBinary } from "@bufbuild/protobuf";
import { OrderSchema, OrderToCancelSchema, Side, ExecutionType } from "./protos/arborter_pb.js";
import type { Order, OrderToCancel } from "./protos/arborter_pb.js";

/**
 * Interface for signing adapters (wallet implementations)
 */
export interface SigningAdapter {
  /**
   * Sign a hex-encoded message
   * @param hexMessage The message to sign as a hex string (with 0x prefix)
   * @returns The signature as a hex string (with 0x prefix)
   */
  signMessage(hexMessage: string): Promise<string>;
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
 * Strip the EVM recovery byte (v) from a 65-byte signature.
 * EVM wallets produce 65-byte signatures (r[32] + s[32] + v[1]),
 * but arborter expects 64 bytes (r + s only).
 */
function stripRecoveryByte(sig: Uint8Array): Uint8Array {
  if (sig.length === 65) {
    return sig.slice(0, 64);
  }
  return sig;
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
  adapter: SigningAdapter
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

  // Convert signature hex to bytes, stripping the EVM recovery byte (v)
  // EVM signatures are 65 bytes (r[32] + s[32] + v[1]), arborter expects 64 bytes (r + s)
  return stripRecoveryByte(hexToBytes(signature));
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
  adapter: SigningAdapter
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

  // Convert signature hex to bytes, stripping the EVM recovery byte (v)
  return stripRecoveryByte(hexToBytes(signature));
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
export function getCancelOrderForSigning(data: CancelSigningData): OrderToCancel {
  return createCancelMessage(data);
}
