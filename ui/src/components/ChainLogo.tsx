"use client";

/**
 * The chain mark for a market leg, in place of the network's name.
 *
 * The logo is resolved by, in order: (1) an explicit per-network override —
 * Sepolia borrows the Ethereum-mainnet mark; (2) a shared Solana mark for any
 * Solana network, whose on-chain id is nominal/null and so useless as a key;
 * (3) the chain's numeric id. A network with no resolvable mark falls back to
 * its short `networkSymbol` (e.g. "SEP"), never the full hyphenated id. The
 * name stays reachable as `alt`/`title`, so it survives hover, screen readers
 * and images-off; an absent network renders nothing.
 */

import { useState } from "react";
import Image from "next/image";
import { useExchangeClient } from "@/lib/hooks/useExchangeClient";
import { networkSymbol } from "@/lib/networkSymbol";

/** Rendered box size in px. Matches the cap height of the surrounding text. */
const SIZE = 14;

/**
 * Every mark ships a `-light` and a `-dark` file, but this app is dark-only:
 * the provider sets `defaultTheme="dark"` with `enableSystem={false}` and
 * nothing calls `setTheme`. Reading the theme here would mean a mounted-guard
 * for a branch that cannot be taken. If a toggle ever lands, swap this for the
 * resolved theme.
 */
const THEME = "dark";

/**
 * Networks that borrow another chain's mark. A testnet has no icon of its own,
 * so it shows its mainnet's — Sepolia → Ethereum mainnet (chainId 1).
 */
const LOGO_OVERRIDE: Record<string, string> = {
  "ethereum-sepolia": "1",
};

/** The `/chain-logos/<slug>-<theme>.png` slug for a network, or undefined. */
function logoSlug(network: string, chainId?: number): string | undefined {
  if (LOGO_OVERRIDE[network]) return LOGO_OVERRIDE[network];
  // Solana networks report a nominal/null chainId; key their mark by family.
  if (network.includes("solana")) return "solana";
  return chainId != null ? String(chainId) : undefined;
}

export function ChainLogo({ network }: { network?: string }) {
  const client = useExchangeClient();

  // Track the SRC that failed, not a bare boolean. A boolean persists across
  // `network` prop changes (React reuses this instance as the selected market
  // cycles), so a single 404 on a logo-less leg would poison every later
  // market — the mark would silently drop back to text even for chains that
  // do have one. Keyed by src, a new network re-attempts cleanly.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!network) return null;

  const chainId =
    client.cache.getConfig()?.chains.find((c) => c.network === network)
      ?.chainId ?? undefined;
  const slug = logoSlug(network, chainId);
  const src = slug ? `/chain-logos/${slug}-${THEME}.png` : undefined;

  if (!src || failedSrc === src) {
    return (
      <span
        title={network}
        className="inline-flex items-center rounded-[2px] bg-muted/40 px-1 font-mono text-[9px] font-semibold uppercase leading-[14px] tracking-wide text-muted-foreground/80 align-[-0.1em]"
      >
        {networkSymbol(network)}
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt={network}
      title={network}
      width={SIZE}
      height={SIZE}
      className="inline-block shrink-0 rounded-[2px] align-[-0.1em]"
      onError={() => setFailedSrc(src)}
      unoptimized
    />
  );
}
