/**
 * A short, distinct label for a chain network — used where a logo mark is not
 * available (see `ChainLogo`), in place of the full network name.
 *
 * Curated for the venue's networks; an unknown network derives a compact
 * abbreviation so a new chain still renders something tidy rather than its
 * whole hyphenated id.
 */
const NETWORK_SYMBOLS: Record<string, string> = {
  "flare-coston2": "C2",
  "flare-coston2-quote": "C2",
  "hyperevm-testnet": "HL",
  "ethereum-sepolia": "SEP",
  "solana-devnet": "SOL",
};

export function networkSymbol(network: string): string {
  const known = NETWORK_SYMBOLS[network];
  if (known) return known;
  // Fallback: first path segment, uppercased and capped — e.g.
  // "arbitrum-sepolia" -> "ARBI". Better a short guess than the full id.
  return (network.split(/[-_]/)[0] || network).slice(0, 4).toUpperCase();
}
