/**
 * Snapshot parity tests for the gasless signing foundation.
 *
 * The three expected hex values in this file are pulled verbatim from
 * the Rust SDK's `aspens/tests/client_parity.rs`. Both sides MUST
 * produce the exact same bytes for the same input — a drift in either
 * (viem's EIP-712 hasher vs alloy's, hand-rolled borsh vs the Rust
 * borsh crate, u64/u128 endianness, etc.) would silently break on-chain
 * verification. If one of these tests breaks, align with the Rust
 * reference rather than updating the snapshot blindly.
 */

import { describe, expect, test } from "bun:test";
import {
  deriveOrderId,
  gaslessLockSigningHash,
  gaslessLockSigningMessage,
  hexToBytes,
  MIDRIB_EIP712_NAME,
  MIDRIB_EIP712_VERSION,
  type OpenOrderArgs,
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

// -- EVM EIP-712 digest --------------------------------------------------

describe("gaslessLockSigningHash", () => {
  test("pins the domain constants against the on-chain contract", () => {
    expect(MIDRIB_EIP712_NAME).toBe("Midrib");
    expect(MIDRIB_EIP712_VERSION).toBe("2");
  });

  test("matches Rust SDK snapshot for the pinned input vector", () => {
    // Copied from aspens/tests/client_parity.rs
    // `evm_gasless_lock_signing_hash_snapshot`.
    const digest = gaslessLockSigningHash({
      order: {
        depositorAddress: "0x0000000000000000000000000000000000000cC3",
        tokenContract: "0x0000000000000000000000000000000000000dD4",
        tokenContractDestinationChain:
          "0x0000000000000000000000000000000000000eE5",
        destinationChainId: "8453",
        amountIn: 1_000_000n,
        amountOut: 2_000_000n,
        orderId: "",
        deadline: 1_700_000_100n,
        nonce: 42n,
        openDeadline: 1_700_000_000n,
      },
      arborterAddress: "0x0000000000000000000000000000000000000aA1",
      originSettler: "0x0000000000000000000000000000000000000bB2",
      originChainId: 84532n,
    });
    expect(digest).toBe(
      "0xdf311c324f054e2b139a5b25950d372ef729a4e5c7132256ca0990170cf4fe40",
    );
  });

  test("rejects zero fillDeadline / openDeadline", () => {
    const base = {
      order: {
        depositorAddress: "0x0000000000000000000000000000000000000001",
        tokenContract: "0x0000000000000000000000000000000000000002",
        tokenContractDestinationChain:
          "0x0000000000000000000000000000000000000003",
        destinationChainId: "1",
        amountIn: 10n,
        amountOut: 10n,
        orderId: "",
        deadline: 0n,
        nonce: 0n,
        openDeadline: 100n,
      },
      arborterAddress:
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
      originSettler:
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
      originChainId: 1n,
    };
    expect(() => gaslessLockSigningHash(base)).toThrow(/non-zero deadline/);
  });
});

// -- Solana borsh payload ------------------------------------------------

describe("gaslessLockSigningMessage", () => {
  test("matches Rust SDK borsh snapshot for the pinned input vector", () => {
    // Copied from aspens/tests/client_parity.rs
    // `solana_gasless_lock_signing_message_snapshot`.
    const order: OpenOrderArgs = {
      orderId: new Uint8Array(32).fill(0x55),
      originChainId: 501n,
      destinationChainId: 8453n,
      inputToken: new Uint8Array(32).fill(0x33),
      inputAmount: 1_000_000n,
      outputToken: new Uint8Array(32).fill(0x44),
      outputAmount: 2_000_000n,
    };

    const bytes = gaslessLockSigningMessage({
      instance: new Uint8Array(32).fill(0x11),
      user: new Uint8Array(32).fill(0x22),
      deadline: 1_700_000_000n,
      order,
    });

    expect(bytes.length).toBe(200);
    expect(bytesToHex(bytes)).toBe(
      "1111111111111111111111111111111111111111111111111111111111111111" +
        "2222222222222222222222222222222222222222222222222222222222222222" +
        "00f1536500000000" +
        "5555555555555555555555555555555555555555555555555555555555555555" +
        "f501000000000000" +
        "0521000000000000" +
        "3333333333333333333333333333333333333333333333333333333333333333" +
        "40420f0000000000" +
        "4444444444444444444444444444444444444444444444444444444444444444" +
        "80841e0000000000",
    );
  });

  test("rejects wrong-sized inputs", () => {
    const bad = {
      instance: new Uint8Array(31), // one short
      user: new Uint8Array(32),
      deadline: 0n,
      order: {
        orderId: new Uint8Array(32),
        originChainId: 0n,
        destinationChainId: 0n,
        inputToken: new Uint8Array(32),
        inputAmount: 0n,
        outputToken: new Uint8Array(32),
        outputAmount: 0n,
      },
    };
    expect(() => gaslessLockSigningMessage(bad)).toThrow(/instance/);
  });
});

// Helper — bytesToHex with lowercase, no prefix, matching the Rust
// `hex::encode` used in the parity fixtures.
function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
}

// Keep TS happy about the import below if hexToBytes becomes unused here.
void hexToBytes;
