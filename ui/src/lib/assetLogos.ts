/**
 * Display names for chains and logo paths for tokens. A network or symbol not
 * listed here shows its own name and a monogram. Chain MARKS come from
 * `ChainLogo`'s `useChainLogoSrc`, the same marks the rest of the terminal
 * uses.
 */

/** Testnets name themselves; their mark is borrowed from mainnet elsewhere. */
const CHAIN_NAMES: Record<string, string> = {
  ethereum: "Ethereum",
  "ethereum-sepolia": "Ethereum Sepolia",
  base: "Base",
  "base-sepolia": "Base Sepolia",
  "arbitrum-one": "Arbitrum",
  "arbitrum-sepolia": "Arbitrum Sepolia",
  "op-sepolia": "OP Sepolia",
  hyperevm: "HyperEVM",
  "hyperevm-testnet": "HyperEVM Testnet",
  robinhood: "Robinhood Chain",
  "robinhood-testnet": "Robinhood Testnet",
  arc: "Arc",
  flare: "Flare",
  "flare-coston2": "Coston2",
  "flare-coston2-quote": "Coston2 Quote",
  "solana-mainnet": "Solana",
  "solana-devnet": "Solana Devnet",
  "solana-localnet": "Solana Localnet",
  tron: "Tron",
  "tron-nile": "Tron Nile",
};

/** Keyed by upper-cased symbol. Wrapped and bridged forms share their underlying mark. */
const TOKEN_LOGOS: Record<string, string> = {
  ETH: "eth.svg",
  WETH: "weth.png",
  USDC: "usdc.svg",
  "USDC.E": "usdc.svg",
  USDT: "usdt.png",
  USDT0: "usdt0.png",
  EURC: "eurc.png",
  USDG: "usdg.png",
  HYPE: "hype.png",
  WHYPE: "hype.png",
  SOL: "sol.png",
  WSOL: "sol.png",
  FLR: "flr.png",
  C2FLR: "flr.png",
  WFLR: "wflr.png",
  SFLR: "sflr.png",
  FXRP: "fxrp.png",
  CIRBTC: "cirbtc.png",
};

export function chainName(network: string): string {
  return CHAIN_NAMES[network] ?? network;
}

export function tokenLogo(symbol: string): string | undefined {
  const file = TOKEN_LOGOS[symbol.toUpperCase()];
  return file && `/token-logos/${file}`;
}
