/**
 * Helpers for resolving which wallet ecosystem a market's chains belong to.
 *
 * The backend config proto tags each chain with an `architecture` string
 * ("EVM", "Solana", "Hedera", ...). This module maps those strings to the
 * wallet `ChainEcosystem` values the UI understands.
 */

import type { Market } from "@aspens/terminal-sdk";
import type { ChainEcosystem } from "./types";

/**
 * Map a `Chain.architecture` string (from the gRPC config) to a wallet ecosystem.
 * Returns `null` for architectures we don't yet have a wallet adapter for.
 */
export function architectureToEcosystem(arch?: string): ChainEcosystem | null {
  if (!arch) return null;
  const normalized = arch.toUpperCase();
  if (normalized === "EVM") return "evm";
  if (normalized === "SOLANA") return "solana";
  return null;
}

/**
 * Resolve the signing ecosystem required for a market.
 *
 * For same-ecosystem markets, returns that ecosystem.
 * Returns `null` if the market spans two different ecosystems (cross-ecosystem
 * signing is not yet supported) or if neither chain has a known architecture.
 */
export function marketEcosystem(market: Market): ChainEcosystem | null {
  const base = architectureToEcosystem(market.baseChainArchitecture);
  const quote = architectureToEcosystem(market.quoteChainArchitecture);
  if (base && quote && base !== quote) return null;
  return base ?? quote ?? null;
}
