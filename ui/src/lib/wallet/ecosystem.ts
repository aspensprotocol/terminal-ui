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
 * Returns `null` if the market spans two different ecosystems or if neither
 * chain has a known architecture. Order placement does NOT use this — it is
 * side-aware via `sideLegs` below, which is what makes cross-ecosystem
 * markets signable. This remains for surfaces that genuinely need one
 * ecosystem for the whole market.
 */
export function marketEcosystem(market: Market): ChainEcosystem | null {
  const base = architectureToEcosystem(market.baseChainArchitecture);
  const quote = architectureToEcosystem(market.quoteChainArchitecture);
  if (base && quote && base !== quote) return null;
  return base ?? quote ?? null;
}

/** The two legs of an order, resolved per side. */
export interface SideLegs {
  /** The leg this order GIVES (buy → quote, sell → base): its wallet signs
   * the envelope and pays the collateral. */
  givingLeg: "base" | "quote";
  /** The leg this order RECEIVES: where fill proceeds settle. */
  receivingLeg: "base" | "quote";
  /** Ecosystem whose wallet must SIGN this order — the giving leg's chain.
   * `null` when that chain's architecture has no wallet adapter. */
  signingEcosystem: ChainEcosystem | null;
  /** Ecosystem of the receiving leg's chain — the wallet whose address is
   * the default settlement destination. `null` when no adapter exists;
   * settlement is still possible by entering an address. */
  receivingEcosystem: ChainEcosystem | null;
}

/**
 * Which wallet signs and which wallet receives, for one order on one market.
 *
 * An order is signed by the wallet on the chain it GIVES (a buy gives
 * quote, a sell gives base) — the venue verifies the envelope signature
 * against that leg's account address. The other leg only needs an ADDRESS,
 * not a signature, so a cross-ecosystem market is signable as long as the
 * giving leg's ecosystem has a connected wallet.
 */
export function sideLegs(market: Market, side: "buy" | "sell"): SideLegs {
  const base = architectureToEcosystem(market.baseChainArchitecture);
  const quote = architectureToEcosystem(market.quoteChainArchitecture);
  const givingLeg = side === "buy" ? "quote" : "base";
  return {
    givingLeg,
    receivingLeg: givingLeg === "quote" ? "base" : "quote",
    signingEcosystem: givingLeg === "quote" ? quote : base,
    receivingEcosystem: givingLeg === "quote" ? base : quote,
  };
}
