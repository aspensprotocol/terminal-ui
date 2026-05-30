/**
 * Order-id derivation — TS foundation layer.
 *
 * Mirrors the Rust SDK's `aspens::orders::derive_order_id`. Under the optimistic
 * shadow ledger, order entry never touches the chain: the arborter authenticates
 * via the outer envelope signature and consumes only `order_id` + `amount_in`.
 * The legacy gasless on-chain-lock signing (EVM EIP-712 `GaslessCrossChainOrder`,
 * Solana `OpenForSignedPayload`) was removed with the on-chain order machinery.
 *
 * Parity is pinned against the Rust SDK's snapshot vector in
 * `aspens/tests/client_parity.rs` — see `gasless.test.ts`. Any drift in the
 * order-id layout breaks that test before it silently breaks id validation.
 */

import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes } from "viem";

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

// -- EVM EIP-712 domain constants ----------------------------------------

/** EIP-712 domain name used by Midrib. Must match the on-chain constant. */
export const MIDRIB_EIP712_NAME = "Midrib";
/** EIP-712 domain version used by MidribV3 (bumped from "2" with the rename). */
export const MIDRIB_EIP712_VERSION = "3";

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

/** Convenience: hex `0x...` → Uint8Array (re-exported for test ergonomics). */
export { hexToBytes };
