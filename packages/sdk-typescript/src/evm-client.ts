/**
 * Chain-correct viem clients for EVM reads.
 *
 * The deposit/withdraw flow used to read through wagmi (`readContract(config,
 * …)`) with no `chainId`. wagmi then falls back to the FIRST chain in its
 * config — `mainnet` — so an allowance query for a Coston2 token was sent to
 * Ethereum via viem's stock public RPC (eth.merkle.io) and failed. Scoping the
 * read by hand was not enough either: wagmi's transport for Coston2 pointed at
 * `http://localhost:8545`, a local-dev anvil no deployed browser can reach.
 *
 * Reads therefore do not go through wagmi at all. They use a client built from
 * the arborter config's chain plus the deployment's RPC map — the same
 * resolution the balances panel uses. Writes stay on wagmi, because they must
 * go through the user's wallet, and are guarded by
 * {@link walletChainMismatch} so a wallet on the wrong network cannot silently
 * broadcast to it.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { resolveRpcUrl, type RpcUrlMap } from "./rpc-urls.js";

/** Minimal chain shape — matches `Configuration.chains[n]`. */
export interface EvmChainRef {
  network: string;
  rpcUrl: string;
  chainId: number;
}

/**
 * A viem public client for `chain`, or throws when no endpoint resolves.
 *
 * Throwing rather than falling back to a default keeps a misconfigured
 * deployment loud: the alternative is viem quietly using its own public RPC
 * for the wrong network, which is exactly the bug this module exists to stop.
 */
export function publicClientFor(
  chain: EvmChainRef,
  rpcUrls: RpcUrlMap | undefined,
): PublicClient {
  const url = resolveRpcUrl(chain, rpcUrls);
  if (!url) {
    throw new Error(
      `No RPC endpoint for '${chain.network}' (chain ${chain.chainId}). ` +
        `The arborter masks rpc_url in GetConfig — set CHAIN_RPC_URLS for ` +
        `this deployment.`,
    );
  }
  return createPublicClient({ transport: http(url) }) as PublicClient;
}

/**
 * Human-readable complaint when the wallet is on the wrong network, or `null`
 * when it is on the right one.
 *
 * `actual` is `undefined` when no wallet is connected — not a mismatch, the
 * caller checks for a connected account separately.
 */
export function walletChainMismatch(
  chain: EvmChainRef,
  actual: number | undefined,
): string | null {
  if (actual === undefined) return null;
  if (actual === chain.chainId) return null;
  return (
    `Wallet is on chain ${actual}, but ${chain.network} is chain ` +
    `${chain.chainId}. Switch networks in your wallet and try again.`
  );
}
