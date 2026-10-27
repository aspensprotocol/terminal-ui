/**
 * Helpers for resolving which wallet ecosystem a market's chains belong to.
 *
 * The backend config proto tags each chain with an `architecture` string
 * ("EVM", "Solana", "Hedera", ...). This module maps those strings to the
 * wallet `ChainEcosystem` values the UI understands.
 */

import { parseArchitecture, type Market } from "@aspensprotocol/sdk-ts";
import type { ChainEcosystem } from "./types";

/**
 * Map a `Chain.architecture` string (from the gRPC config) to a wallet
 * ecosystem, as a closed match: "EVM", "Solana" and "Tron" (any case; the
 * empty proto default is EVM) each map to their own ecosystem, and anything
 * else throws. An unknown architecture must never fall through to another
 * chain's signing path. `undefined` (a market whose chain config is not
 * joined yet) has no ecosystem and returns `null`.
 */
export function architectureToEcosystem(arch?: string): ChainEcosystem | null {
  if (arch === undefined) return null;
  return parseArchitecture(arch);
}

/**
 * Resolve the signing ecosystem required for a market.
 *
 * For same-ecosystem markets, returns that ecosystem.
 * Returns `null` if the market spans two different ecosystems or if neither
 * chain's architecture is joined in. Order placement does NOT use this — it is
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
   * `null` when that chain's architecture is not joined into the market. */
  signingEcosystem: ChainEcosystem | null;
  /** Ecosystem of the receiving leg's chain — the wallet whose address is
   * the default settlement destination. `null` when that chain's
   * architecture is not joined into the market; settlement is still
   * possible by entering an address. */
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

/** "an EVM wallet", "a Solana wallet", "a Tron wallet": for messages. */
export function walletPhrase(ecosystem: ChainEcosystem): string {
  switch (ecosystem) {
    case "evm":
      return "an EVM wallet";
    case "solana":
      return "a Solana wallet";
    case "tron":
      return "a Tron wallet";
    default:
      return unreachableEcosystem(ecosystem);
  }
}

/**
 * The `default` arm of an exhaustive `switch` over {@link ChainEcosystem}: a
 * compile error when a case is missing, and a throw if a value outside the
 * type reaches it at runtime anyway.
 */
export function unreachableEcosystem(ecosystem: never): never {
  throw new Error(`unhandled wallet ecosystem "${String(ecosystem)}"`);
}
