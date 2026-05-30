/**
 * Solana order-authorization builder.
 *
 * Counterpart to `gasless-evm.ts`. Under the optimistic shadow ledger, order
 * entry never touches the chain: the arborter authenticates via the outer
 * envelope signature and consumes only `order_id` + `amount_in`. This builder
 * resolves chains / tokens / amounts, derives the canonical 32-byte order id,
 * and packs the `OrderAuthorization`. No borsh `open_for` payload, no Ed25519
 * lock signature — those were removed with the on-chain order machinery.
 */

import { create } from "@bufbuild/protobuf";
import { PublicKey } from "@solana/web3.js";

import { deriveOrderId } from "./gasless.js";
import {
  OrderAuthorizationSchema,
  type OrderAuthorization,
} from "./protos/arborter_pb.js";
import type { Configuration } from "./protos/arborter_config_pb.js";
import type { Market } from "./types.js";

export interface BuildSolanaGaslessOpts {
  market: Market;
  config: Configuration;
  side: "buy" | "sell";
  /** Input-token amount in base units (matches the origin mint's decimals). */
  amountIn: bigint;
  /** Output-token amount in base units. */
  amountOut: bigint;
  /** User's Solana address (base58). */
  userAddress: string;
  /** Optional nonce override for `deriveOrderId`. Defaults to current unix ms. */
  clientNonce?: bigint;
}

export async function buildSolanaGaslessAuthorization(
  opts: BuildSolanaGaslessOpts,
): Promise<{
  authorization: OrderAuthorization;
  orderId: string;
}> {
  const originChain = resolveChain(
    opts.config,
    opts.side === "buy"
      ? opts.market.quoteChainNetwork
      : opts.market.baseChainNetwork,
  );
  const destinationChain = resolveChain(
    opts.config,
    opts.side === "buy"
      ? opts.market.baseChainNetwork
      : opts.market.quoteChainNetwork,
  );

  if (!originChain.architecture.match(/^solana$/i)) {
    throw new Error(
      `buildSolanaGaslessAuthorization called on non-Solana origin chain '${originChain.network}'`,
    );
  }

  const inputTicker =
    opts.side === "buy" ? opts.market.quote_ticker : opts.market.base_ticker;
  const outputTicker =
    opts.side === "buy" ? opts.market.base_ticker : opts.market.quote_ticker;

  const inputToken = requireTokenAddress(originChain, inputTicker);
  const outputToken = requireTokenAddress(destinationChain, outputTicker);

  const user = new PublicKey(opts.userAddress);
  const originChainId = BigInt(originChain.chainId);
  const destinationChainId = BigInt(destinationChain.chainId);

  const clientNonce = opts.clientNonce ?? BigInt(Date.now());

  // Derive the canonical 32-byte order id. Output token may be EVM (20-byte
  // address) or Solana (32-byte pubkey); `outputTokenBytes32` coerces both to
  // the 32-byte form the arborter hashes on its side.
  const inputMint = new PublicKey(inputToken);
  const outputTokenBytes = outputTokenBytes32(
    outputToken,
    destinationChain.architecture,
  );
  const orderIdBytes = deriveOrderId({
    userPubkey: user.toBuffer(),
    clientNonce,
    originChainId,
    destinationChainId,
    inputToken: inputMint.toBuffer(),
    outputToken: outputTokenBytes,
    inputAmount: opts.amountIn,
    outputAmount: opts.amountOut,
  });
  const orderId = `0x${bytesToHex(orderIdBytes)}`;

  const authorization = create(OrderAuthorizationSchema, {
    orderId,
    amountIn: opts.amountIn.toString(),
  });

  return { authorization, orderId };
}

// -- helpers -------------------------------------------------------------

type ConfigChain = Configuration["chains"][number];

function resolveChain(
  config: Configuration,
  network: string | undefined,
): ConfigChain {
  if (!network) {
    throw new Error("Market is missing a chain network — cannot resolve");
  }
  const chain = config.chains.find((c) => c.network === network);
  if (!chain) {
    throw new Error(`Chain '${network}' not found in arborter configuration`);
  }
  return chain;
}

function requireTokenAddress(chain: ConfigChain, symbol: string): string {
  const token = chain.tokens[symbol];
  if (!token) {
    throw new Error(
      `Token '${symbol}' not configured on chain '${chain.network}'`,
    );
  }
  return token.address;
}

/**
 * Coerce an output-token identifier into the 32-byte form the order-id hash
 * expects.
 *
 *   - Solana destination: parse as base58 → 32 bytes directly.
 *   - EVM destination: parse as 0x-hex address (20 bytes), left-pad to 32.
 */
function outputTokenBytes32(
  tokenAddress: string,
  architecture: string,
): Uint8Array {
  if (architecture.match(/^solana$/i)) {
    return new PublicKey(tokenAddress).toBuffer();
  }
  // EVM / default: strip 0x, decode hex, right-align into 32 bytes.
  const hex = tokenAddress.toLowerCase().replace(/^0x/, "");
  const raw = hexToBytesLocal(hex);
  if (raw.length > 32) {
    throw new Error(
      `output token '${tokenAddress}' exceeds 32 bytes; cannot embed in order-id hash`,
    );
  }
  const out = new Uint8Array(32);
  out.set(raw, 32 - raw.length);
  return out;
}

function hexToBytesLocal(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex string of odd length: '${hex}'`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
}
