"use client";

/**
 * The chain mark for a market leg, in place of the network's name.
 *
 * The name stays reachable as `alt` and `title`, so it survives hover, screen
 * readers and images-off. A network with no resolvable mark falls back to the
 * `(network)` text rather than a broken image or a gap; an absent network
 * renders nothing, since `Market.baseChainNetwork` is optional.
 */

import { useState } from "react";
import Image from "next/image";
import { useExchangeClient } from "@/lib/hooks/useExchangeClient";

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

export function ChainLogo({ network }: { network?: string }) {
  const client = useExchangeClient();
  const [failed, setFailed] = useState(false);

  const chainId = network
    ? client.cache.getConfig()?.chains.find((c) => c.network === network)
        ?.chainId
    : undefined;

  if (!network) return null;
  if (chainId === undefined || failed) {
    return <span className="text-muted-foreground/60">({network})</span>;
  }

  return (
    <Image
      src={`/chain-logos/${chainId}-${THEME}.png`}
      alt={network}
      title={network}
      width={SIZE}
      height={SIZE}
      className="inline-block shrink-0 rounded-[2px] align-[-0.1em]"
      onError={() => setFailed(true)}
      unoptimized
    />
  );
}
