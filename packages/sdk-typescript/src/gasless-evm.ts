/**
 * EVM gasless-order orchestrator.
 *
 * Connects the foundation layer in `./gasless.ts` to the UI's wallet +
 * arborter-config machinery. Produces a `GaslessAuthorization` ready to
 * drop into a `SendOrderRequest`:
 *
 *   1. Resolve chain config (MidribV2 settler, arborter signer, Permit2,
 *      chain id, origin token, destination token) from the cached
 *      `Configuration` and the active `Market`.
 *   2. Fetch the user's current Permit2 nonce on-chain via viem.
 *   3. Build `GaslessLockParams`, compute the EIP-712 digest, and have
 *      the wallet sign via `signTypedData` (eth_signTypedData_v4).
 *   4. Derive the canonical 32-byte order id.
 *   5. Pack everything into the proto `GaslessAuthorization`.
 */

import { create } from "@bufbuild/protobuf";
import {
  createPublicClient,
  hexToBytes,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

import {
  deriveOrderId,
  gaslessLockSigningHash,
  type GaslessLockParams,
} from "./gasless.js";
import {
  GaslessAuthorizationSchema,
  type GaslessAuthorization,
} from "./protos/arborter_pb.js";
import type { Configuration } from "./protos/arborter_config_pb.js";
import type { SigningAdapter } from "./signing.js";
import type { Market } from "./types.js";

/**
 * IAllowanceTransfer (Permit2) just the bit we need: the allowance getter
 * returns (amount, expiration, nonce). We only care about nonce.
 */
const PERMIT2_ABI = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

export interface BuildEvmGaslessOpts {
  /** Market the order is being placed on. Must be an EVM-on-EVM market. */
  market: Market;
  /**
   * Current `Configuration` — pulled from `client.cache.getConfig()`.
   * Required because the gasless params need origin-chain contracts
   * (MidribV2, Permit2, arborter signer) that aren't on the Market itself.
   */
  config: Configuration;
  /** "buy" picks the quote chain as origin; "sell" picks the base chain. */
  side: "buy" | "sell";
  /** Input amount (on-origin-chain token) in raw base units. */
  amountIn: bigint;
  /** Output amount (on-destination-chain token) in raw base units. */
  amountOut: bigint;
  /** User's address on the origin chain (EVM hex). */
  userAddress: Address;
  /** Signing adapter; must implement `signTypedData`. */
  adapter: SigningAdapter;
  /**
   * Optional overrides for the EIP-712 deadlines, in unix seconds. Defaults:
   *   fillDeadline  = now + 10 minutes
   *   openDeadline  = now + 5 minutes
   * Both must fit in uint32 (through 2106 — plenty of runway).
   */
  fillDeadlineSeconds?: bigint;
  openDeadlineSeconds?: bigint;
}

/**
 * Build a `GaslessAuthorization` for an EVM-origin order. Also returns the
 * derived order id and Permit2 nonce for logging / debugging.
 */
export async function buildEvmGaslessAuthorization(
  opts: BuildEvmGaslessOpts,
): Promise<{
  authorization: GaslessAuthorization;
  orderId: Hex;
  permit2Nonce: bigint;
}> {
  if (!opts.adapter.signMessage) {
    throw new Error(
      "EVM gasless signing requires a wallet adapter with signMessage support",
    );
  }

  const originChain = resolveOriginChain(opts.market, opts.config, opts.side);
  const destinationChain = resolveDestinationChain(
    opts.market,
    opts.config,
    opts.side,
  );

  const inputTokenAddress = requireToken(
    originChain,
    opts.side === "buy" ? opts.market.quote_ticker : opts.market.base_ticker,
  );
  const outputTokenAddress = requireToken(
    destinationChain,
    opts.side === "buy" ? opts.market.base_ticker : opts.market.quote_ticker,
  );

  const midribAddress = requireAddress(
    originChain.tradeContract?.address,
    `chain '${originChain.network}' has no trade_contract.address (MidribV2 settler)`,
  );
  const permit2Address = requireAddress(
    originChain.permit2Address,
    `chain '${originChain.network}' has no permit2_address`,
  );
  const arborterAddress = requireAddress(
    originChain.instanceSignerAddress,
    `chain '${originChain.network}' has no instance_signer_address (arborter)`,
  );

  const permit2Nonce = await fetchPermit2Nonce({
    rpcUrl: originChain.rpcUrl,
    permit2Address,
    user: opts.userAddress,
    token: inputTokenAddress,
    spender: arborterAddress,
  });

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const fillDeadline = opts.fillDeadlineSeconds ?? nowSeconds + 600n;
  const openDeadline = opts.openDeadlineSeconds ?? nowSeconds + 300n;
  const originChainId = BigInt(originChain.chainId);
  const destinationChainId = BigInt(destinationChain.chainId);

  // order_id is the client-chosen 32-byte identifier the arborter binds the
  // user's signature to. Using the Permit2 nonce as clientNonce keeps it
  // stable-per-order and unique for a given (user, token, spender) tuple.
  const orderIdBytes = deriveOrderId({
    userPubkey: hexToBytes(opts.userAddress),
    clientNonce: permit2Nonce,
    originChainId,
    destinationChainId,
    inputToken: hexToBytes(inputTokenAddress),
    outputToken: hexToBytes(outputTokenAddress),
    inputAmount: opts.amountIn,
    outputAmount: opts.amountOut,
  });
  const orderId = bytesToHexPrefixed(orderIdBytes);

  const params: GaslessLockParams = {
    depositorAddress: opts.userAddress,
    tokenContract: inputTokenAddress,
    tokenContractDestinationChain: outputTokenAddress,
    destinationChainId: destinationChainId.toString(),
    amountIn: opts.amountIn,
    amountOut: opts.amountOut,
    orderId,
    deadline: fillDeadline,
    nonce: permit2Nonce,
    openDeadline,
  };

  // MidribV2._verifyOrder wraps the EIP-712 digest with EIP-191
  // ("\x19Ethereum Signed Message:\n32") before ecrecover — the legacy
  // TPMSigner-shaped recipe. The user's signature must be over the
  // EIP-191-wrapped digest, not the raw EIP-712 hash. wagmi's
  // signMessage({ message: { raw } }) applies that prefix; signTypedData
  // would NOT and on-chain recovery would yield a different address
  // (custom error 0x6cbfd82c = INVALID_SIGNER). Mirrors the Rust SDK's
  // `wallet.sign_message(digest)` path in
  // `aspens::commands::trading::gasless::build_evm`.
  const digest = gaslessLockSigningHash({
    order: params,
    arborterAddress,
    originSettler: midribAddress,
    originChainId,
  });
  const signatureHex = await opts.adapter.signMessage(digest);

  // The arborter rebuilds the EIP-712 typed data from these fields to
  // verify the user's signature — any drift between what we signed and
  // what we send in the authorization breaks signature recovery. Keep
  // `nonce` = Permit2 nonce + `openDeadline` identical to the values
  // used in `gaslessLockSigningHash` above.
  const authorization = create(GaslessAuthorizationSchema, {
    userSignature: hexToBytes(signatureHex as Hex),
    deadline: fillDeadline,
    orderId,
    nonce: permit2Nonce,
    openDeadline,
  });

  return { authorization, orderId, permit2Nonce };
}

// -- Internal helpers ----------------------------------------------------

async function fetchPermit2Nonce(opts: {
  rpcUrl: string;
  permit2Address: Address;
  user: Address;
  token: Address;
  spender: Address;
}): Promise<bigint> {
  const client = createPublicClient({
    transport: http(opts.rpcUrl),
  });
  const [, , nonce] = await client.readContract({
    address: opts.permit2Address,
    abi: PERMIT2_ABI,
    functionName: "allowance",
    args: [opts.user, opts.token, opts.spender],
  });
  return BigInt(nonce);
}

function resolveOriginChain(
  market: Market,
  config: Configuration,
  side: "buy" | "sell",
): ConfigChain {
  // Buy = spend quote, receive base → origin is the quote chain.
  // Sell = spend base, receive quote → origin is the base chain.
  const network =
    side === "buy" ? market.quoteChainNetwork : market.baseChainNetwork;
  if (!network) {
    throw new Error(
      `market '${market.id}' has no ${side === "buy" ? "quoteChainNetwork" : "baseChainNetwork"} — cannot build gasless auth`,
    );
  }
  return requireChain(config, network);
}

function resolveDestinationChain(
  market: Market,
  config: Configuration,
  side: "buy" | "sell",
): ConfigChain {
  const network =
    side === "buy" ? market.baseChainNetwork : market.quoteChainNetwork;
  if (!network) {
    throw new Error(
      `market '${market.id}' has no ${side === "buy" ? "baseChainNetwork" : "quoteChainNetwork"} — cannot build gasless auth`,
    );
  }
  return requireChain(config, network);
}

type ConfigChain = Configuration["chains"][number];

function requireChain(config: Configuration, network: string): ConfigChain {
  const chain = config.chains.find((c) => c.network === network);
  if (!chain) {
    throw new Error(
      `chain '${network}' not found in arborter configuration — cannot build gasless auth`,
    );
  }
  return chain;
}

function requireToken(chain: ConfigChain, symbol: string): Address {
  const entry = chain.tokens[symbol];
  if (!entry) {
    throw new Error(
      `token '${symbol}' not configured on chain '${chain.network}'`,
    );
  }
  return entry.address as Address;
}

function requireAddress(value: string | undefined, msg: string): Address {
  if (!value) throw new Error(msg);
  return value as Address;
}

function bytesToHexPrefixed(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}
