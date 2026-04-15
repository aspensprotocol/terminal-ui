/**
 * Gasless order-signing helpers — TS foundation layer.
 *
 * Mirrors the Rust SDK's `aspens::orders` / `aspens::evm` /
 * `aspens::solana` gasless helpers. The arborter is moving to require
 * client-signed gasless authorizations on EVM chains (see PR: "arborter
 * EVM lock_for_order → deprecate arborter-signed path"); once that
 * lands, every EVM `SendOrderRequest` must carry a user-produced
 * ECDSA signature over the EIP-712 digest this module computes. Solana
 * has the analogous open_for flow — the user signs the borsh payload
 * that `gaslessLockSigningMessage()` produces and the arborter submits
 * on-chain with the Ed25519SigVerify precompile.
 *
 * Parity is pinned against the Rust SDK's snapshot vectors in
 * `aspens/tests/client_parity.rs` — see `gasless.test.ts`. Any drift
 * in layout, constants, or hashing will break those tests before it
 * silently breaks on-chain verification.
 */

import { sha256 } from "@noble/hashes/sha256";
import {
  encodeAbiParameters,
  hashTypedData,
  hexToBytes,
  type Address,
  type Hex,
} from "viem";

// -- Chain-agnostic order id ---------------------------------------------

/**
 * Derive the canonical 32-byte order id. Both client and arborter
 * MUST produce the same hash for a given intent; mismatches fail
 * `SendOrderRequest` validation.
 *
 * Layout (little-endian for integers):
 *   sha256(
 *     user_pubkey || client_nonce || origin_chain_id || destination_chain_id ||
 *     input_token || output_token || input_amount || output_amount
 *   )
 */
export function deriveOrderId(params: {
  userPubkey: Uint8Array;
  clientNonce: bigint;
  originChainId: bigint;
  destinationChainId: bigint;
  inputToken: Uint8Array;
  outputToken: Uint8Array;
  inputAmount: bigint;
  outputAmount: bigint;
}): Uint8Array {
  const buf: Uint8Array[] = [
    params.userPubkey,
    u64Le(params.clientNonce),
    u64Le(params.originChainId),
    u64Le(params.destinationChainId),
    params.inputToken,
    params.outputToken,
    u128Le(params.inputAmount),
    u128Le(params.outputAmount),
  ];
  const totalLen = buf.reduce((a, b) => a + b.length, 0);
  const flat = new Uint8Array(totalLen);
  let off = 0;
  for (const b of buf) {
    flat.set(b, off);
    off += b.length;
  }
  return sha256(flat);
}

// -- Shared gasless lock params ------------------------------------------

/**
 * Shared input struct fed to the chain-specific signing helpers.
 * Fields are chain-specific where noted; harmless-but-ignored defaults
 * are fine for the other chain.
 */
export interface GaslessLockParams {
  /** User's address (0x-hex for EVM, base58 for Solana). */
  depositorAddress: string;
  /** Origin-chain token contract. ERC-20 address (EVM) or mint (Solana base58). */
  tokenContract: string;
  /** Destination-chain token contract (address or mint). */
  tokenContractDestinationChain: string;
  /** Destination chain id as a decimal string. */
  destinationChainId: string;
  /** Amount of input token in base units. */
  amountIn: bigint;
  /** Amount of output token in base units. */
  amountOut: bigint;
  /**
   * Opaque 32-byte order id. Typically `deriveOrderId(...)` hex output.
   * EVM path may accept empty string when the id is computed on-chain.
   */
  orderId: string;
  /**
   * Chain-specific absolute deadline:
   *   * Solana: slot number.
   *   * EVM:    unix-seconds `fillDeadline`.
   */
  deadline: bigint;
  /**
   * Permit2 / EIP-712 nonce. Embedded in the EVM `PermitSingle`; ignored
   * on Solana.
   */
  nonce: bigint;
  /** EVM-only `openDeadline` (unix seconds). Ignored on Solana. */
  openDeadline: bigint;
}

// -- EVM EIP-712 digest --------------------------------------------------

/** EIP-712 domain name used by MidribV2. Must match the on-chain constant. */
export const MIDRIB_EIP712_NAME = "Midrib";
/** EIP-712 domain version used by MidribV2. */
export const MIDRIB_EIP712_VERSION = "2";

/** `MidribDataTypes.IntentAction.LOCK` = enum index 2. */
const INTENT_ACTION_LOCK = 2;

/**
 * Produce the 32-byte EIP-712 digest a user's EVM wallet must sign to
 * authorize a gasless lock. Wallet signs this digest via `eth_signTypedData_v4`
 * (or viem's `signTypedData`); the arborter recovers the user's address
 * from the signature and submits `openFor` on-chain.
 */
export function gaslessLockSigningHash(params: {
  order: GaslessLockParams;
  arborterAddress: Address;
  originSettler: Address;
  originChainId: bigint;
}): Hex {
  const { order, arborterAddress, originSettler, originChainId } = params;
  if (order.deadline === 0n || order.openDeadline === 0n) {
    throw new Error(
      "EVM gasless order requires non-zero deadline (fillDeadline) and openDeadline",
    );
  }
  if (order.deadline > 0xffffffffn || order.openDeadline > 0xffffffffn) {
    throw new Error(
      "EVM gasless deadlines must fit in uint32 (contract field width)",
    );
  }

  // Normalize address case — the Rust reference uses alloy which accepts
  // any case; viem's encoder enforces EIP-55, so we lowercase to stay
  // byte-identical regardless of input casing.
  const tokenIn = order.tokenContract.toLowerCase() as Address;
  const tokenOut = order.tokenContractDestinationChain.toLowerCase() as Address;
  const user = order.depositorAddress.toLowerCase() as Address;
  const arborter = arborterAddress.toLowerCase() as Address;
  const settler = originSettler.toLowerCase() as Address;

  // Inner orderData: abi.encode(IntentAction, PermitSingle, OrderData).
  const encodedOrderData = encodeAbiParameters(
    [
      { type: "uint8" },
      {
        type: "tuple",
        components: [
          {
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint160" },
              { name: "expiration", type: "uint48" },
              { name: "nonce", type: "uint48" },
            ],
            name: "details",
          },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      {
        type: "tuple",
        components: [
          { name: "outputToken", type: "address" },
          { name: "outputAmount", type: "uint160" },
          { name: "inputAmount", type: "uint160" },
          { name: "recipient", type: "address" },
          { name: "destinationChainId", type: "uint256" },
          { name: "exclusiveRelayer", type: "address" },
          { name: "message", type: "bytes" },
        ],
      },
    ],
    [
      INTENT_ACTION_LOCK,
      {
        details: {
          token: tokenIn,
          amount: order.amountIn,
          // uint48 is encoded as a JS number; order.nonce fits (< 2^48).
          expiration: 0,
          nonce: Number(order.nonce),
        },
        spender: arborter,
        sigDeadline: 0n,
      },
      {
        outputToken: tokenOut,
        outputAmount: order.amountOut,
        inputAmount: order.amountIn,
        recipient: user,
        destinationChainId: BigInt(order.destinationChainId),
        exclusiveRelayer: arborter,
        message: "0x",
      },
    ],
  );

  return hashTypedData({
    domain: {
      name: MIDRIB_EIP712_NAME,
      version: MIDRIB_EIP712_VERSION,
      chainId: Number(originChainId),
      verifyingContract: settler,
    },
    types: {
      GaslessCrossChainOrder: [
        { name: "originSettler", type: "address" },
        { name: "user", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "originChainId", type: "uint256" },
        { name: "openDeadline", type: "uint32" },
        { name: "fillDeadline", type: "uint32" },
        { name: "orderDataType", type: "bytes32" },
        { name: "orderData", type: "bytes" },
      ],
    },
    primaryType: "GaslessCrossChainOrder",
    message: {
      originSettler: settler,
      user,
      nonce: order.nonce,
      originChainId,
      openDeadline: Number(order.openDeadline),
      fillDeadline: Number(order.deadline),
      orderDataType: `0x${"00".repeat(32)}` as Hex,
      orderData: encodedOrderData,
    },
  });
}

// -- Solana gasless borsh payload ---------------------------------------

/**
 * Arguments to the Midrib `open` / `open_for` instructions — user-level
 * order intent. Pubkey fields are raw 32-byte arrays.
 */
export interface OpenOrderArgs {
  orderId: Uint8Array; // 32 bytes
  originChainId: bigint;
  destinationChainId: bigint;
  inputToken: Uint8Array; // 32-byte pubkey
  inputAmount: bigint; // u64
  outputToken: Uint8Array; // 32 bytes (may represent an EVM address left-padded)
  outputAmount: bigint; // u64
}

/**
 * The exact bytes a user's Ed25519 key must sign to authorize a gasless
 * `open_for` on Solana. Layout matches the Rust SDK's borsh-derived
 * `OpenForSignedPayload`; the arborter reconstructs the same byte
 * sequence and verifies the signature via the Ed25519SigVerify precompile.
 *
 * Borsh layout (no length prefixes on fixed-size struct fields):
 *   instance (32) || user (32) || deadline (u64 LE) ||
 *   orderId (32) || originChainId (u64 LE) || destinationChainId (u64 LE) ||
 *   inputToken (32) || inputAmount (u64 LE) ||
 *   outputToken (32) || outputAmount (u64 LE)
 * Total: 200 bytes.
 */
export function gaslessLockSigningMessage(params: {
  instance: Uint8Array; // 32-byte pubkey
  user: Uint8Array; // 32-byte pubkey
  deadline: bigint; // u64 slot number
  order: OpenOrderArgs;
}): Uint8Array {
  assertLen(params.instance, 32, "instance");
  assertLen(params.user, 32, "user");
  assertLen(params.order.orderId, 32, "orderId");
  assertLen(params.order.inputToken, 32, "inputToken");
  assertLen(params.order.outputToken, 32, "outputToken");

  const out = new Uint8Array(200);
  let off = 0;
  out.set(params.instance, off);
  off += 32;
  out.set(params.user, off);
  off += 32;
  out.set(u64Le(params.deadline), off);
  off += 8;
  out.set(params.order.orderId, off);
  off += 32;
  out.set(u64Le(params.order.originChainId), off);
  off += 8;
  out.set(u64Le(params.order.destinationChainId), off);
  off += 8;
  out.set(params.order.inputToken, off);
  off += 32;
  out.set(u64Le(params.order.inputAmount), off);
  off += 8;
  out.set(params.order.outputToken, off);
  off += 32;
  out.set(u64Le(params.order.outputAmount), off);
  off += 8;
  return out;
}

// -- Local helpers -------------------------------------------------------

function u64Le(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffffffffffffffffn) {
    throw new Error(`value ${n} out of u64 range`);
  }
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u128Le(n: bigint): Uint8Array {
  if (n < 0n || n > (1n << 128n) - 1n) {
    throw new Error(`value ${n} out of u128 range`);
  }
  const out = new Uint8Array(16);
  let v = n;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function assertLen(b: Uint8Array, want: number, label: string): void {
  if (b.length !== want) {
    throw new Error(`${label}: expected ${want} bytes, got ${b.length}`);
  }
}

/** Convenience: hex `0x...` → Uint8Array (re-exported for test ergonomics). */
export { hexToBytes };
