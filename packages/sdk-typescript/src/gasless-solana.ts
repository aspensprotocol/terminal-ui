/**
 * Solana gasless-order orchestrator.
 *
 * Counterpart to `gasless-evm.ts`. Given a market + order params +
 * wallet, build a `GaslessAuthorization` ready to drop into a
 * `SendOrderRequest`. The arborter rebuilds the same borsh payload,
 * verifies the user's Ed25519 signature via the Ed25519SigVerify
 * precompile, and submits `open_for` as fee-payer.
 */

import { create } from "@bufbuild/protobuf";
import { Connection, PublicKey } from "@solana/web3.js";

import {
  deriveOrderId,
  gaslessLockSigningMessage,
  type OpenOrderArgs,
} from "./gasless.js";
import {
  GaslessAuthorizationSchema,
  type GaslessAuthorization,
} from "./protos/arborter_pb.js";
import type { Configuration } from "./protos/arborter_config_pb.js";
import type { SigningAdapter } from "./signing.js";
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
  /** Signing adapter; must implement `signBytes`. */
  adapter: SigningAdapter;
  /**
   * Optional deadline override, in slots. Defaults to current slot + 300
   * (~2 minutes on mainnet at 400ms slot time). If the arborter can't
   * land the tx before this slot, the on-chain program rejects.
   */
  deadlineSlot?: bigint;
  /** Optional nonce override for `deriveOrderId`. Defaults to current unix ms. */
  clientNonce?: bigint;
}

export async function buildSolanaGaslessAuthorization(
  opts: BuildSolanaGaslessOpts,
): Promise<{
  authorization: GaslessAuthorization;
  orderId: string;
}> {
  if (!opts.adapter.signBytes) {
    throw new Error(
      "Solana gasless signing requires a wallet adapter with signBytes support",
    );
  }

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
  const instanceStr = originChain.tradeContract?.address;
  if (!instanceStr) {
    throw new Error(
      `Solana chain '${originChain.network}' has no trade_contract.address (instance PDA)`,
    );
  }

  const user = new PublicKey(opts.userAddress);
  const instance = new PublicKey(instanceStr);

  const originChainId = BigInt(originChain.chainId);
  const destinationChainId = BigInt(destinationChain.chainId);

  // Solana deadlines are slot-based. If no override, pull the current
  // slot and add a buffer — enough time for the arborter to sign, land,
  // and confirm before the on-chain program would reject.
  let deadline: bigint;
  if (opts.deadlineSlot !== undefined) {
    deadline = opts.deadlineSlot;
  } else {
    const slot = await new Connection(originChain.rpcUrl).getSlot();
    deadline = BigInt(slot) + 300n;
  }

  const clientNonce = opts.clientNonce ?? BigInt(Date.now());

  // Derive the canonical 32-byte order id. On Solana this is also the
  // `Order` PDA seed — the arborter uses it as the init seed when
  // submitting `open_for`, so a mismatch fails program validation.
  const inputMint = new PublicKey(inputToken);
  // Output token may be EVM (20-byte address) or Solana (32-byte pubkey).
  // For the order-id hash we pass the raw bytes we'll also put in the
  // borsh payload; `outputTokenBytesForBorsh` handles both forms.
  const outputTokenBytes = outputTokenBytesForBorsh(
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

  const order: OpenOrderArgs = {
    orderId: orderIdBytes,
    originChainId,
    destinationChainId,
    inputToken: inputMint.toBuffer(),
    inputAmount: opts.amountIn,
    outputToken: outputTokenBytes,
    outputAmount: opts.amountOut,
  };

  const message = gaslessLockSigningMessage({
    instance: instance.toBuffer(),
    user: user.toBuffer(),
    deadline,
    order,
  });

  const signatureBytes = await opts.adapter.signBytes(message);

  // `nonce` and `openDeadline` are ignored by the Solana path on the
  // arborter (the Order PDA's init serves as the nonce; there's no
  // openDeadline concept). Leave them at their proto-default zero.
  const authorization = create(GaslessAuthorizationSchema, {
    userSignature: signatureBytes,
    deadline,
    orderId,
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
 * Coerce an output-token identifier into the 32-byte form borsh expects.
 *
 *   - Solana destination: parse as base58 → 32 bytes directly.
 *   - EVM destination: parse as 0x-hex address (20 bytes), left-pad to
 *     32 with zeros. The on-chain program treats it as an opaque
 *     identifier — the exact framing just has to match what the
 *     arborter does on its side.
 */
function outputTokenBytesForBorsh(
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
      `output token '${tokenAddress}' exceeds 32 bytes; cannot embed in borsh payload`,
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
