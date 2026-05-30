/**
 * Snapshot parity tests for the order-id foundation.
 *
 * The expected hex is pulled verbatim from the Rust SDK's
 * `aspens/tests/client_parity.rs`. Both sides MUST produce the exact same
 * bytes for the same input — a drift in u64/u128 endianness or field order
 * would silently break order-id validation. If this breaks, align with the
 * Rust reference rather than updating the snapshot blindly. (The legacy
 * gasless lock-signing parity tests were removed with the on-chain order
 * machinery.)
 */

import { describe, expect, test } from "bun:test";
import {
  deriveOrderId,
  MIDRIB_EIP712_NAME,
  MIDRIB_EIP712_VERSION,
} from "./gasless.js";

// -- chain-agnostic order id ---------------------------------------------

describe("deriveOrderId", () => {
  test("matches Rust SDK snapshot for the pinned input vector", () => {
    // Copied from aspens/tests/client_parity.rs `derive_order_id_snapshot`.
    const id = deriveOrderId({
      userPubkey: new Uint8Array(32).fill(0xaa),
      clientNonce: 42n,
      originChainId: 501n,
      destinationChainId: 8453n,
      inputToken: new TextEncoder().encode("InputMintPubkey32BytesRepresentat"),
      outputToken: new TextEncoder().encode("0xOutputTokenAddressEvmLower4321"),
      inputAmount: 1_000_000n,
      outputAmount: 2_000_000n,
    });
    expect(bytesToHex(id)).toBe(
      "642e8b1deac921a7ddc00254b847ed1eb90169b1d3a70a34b541b66617b63843",
    );
  });

  test("is deterministic", () => {
    const i = {
      userPubkey: new Uint8Array(32).fill(1),
      clientNonce: 1n,
      originChainId: 1n,
      destinationChainId: 2n,
      inputToken: new Uint8Array([1, 2]),
      outputToken: new Uint8Array([3, 4]),
      inputAmount: 10n,
      outputAmount: 20n,
    };
    expect(bytesToHex(deriveOrderId(i))).toBe(bytesToHex(deriveOrderId(i)));
  });
});

// -- EVM domain constants ------------------------------------------------

describe("EIP-712 domain constants", () => {
  test("pin against the on-chain contract (MidribV3 bumped version to 3)", () => {
    expect(MIDRIB_EIP712_NAME).toBe("Midrib");
    expect(MIDRIB_EIP712_VERSION).toBe("3");
  });
});

// Helper — bytesToHex with lowercase, no prefix, matching the Rust
// `hex::encode` used in the parity fixtures.
function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
}
