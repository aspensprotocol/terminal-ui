import { type Config, createConfig, http } from "wagmi";
import {
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
} from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { defineChain } from "viem";

// WalletConnect project ID - you should get your own at https://cloud.walletconnect.com
const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  "c3690594c774dccbd4a0272ae38f1953";

// Flare Coston2 — also covers the local anvil-fork dev setup where two
// "networks" (flare-coston2 and flare-coston2-quote) share chainId 114.
// wagmi keys by chainId, so a single entry is enough for the connector to
// accept the chain when the wallet is on it.
//
// These entries exist so the CONNECTOR knows the chain (name, currency,
// explorer, and a network to offer when adding it to a wallet). Deposit and
// withdraw no longer read through wagmi's transports at all — they build a
// client from the arborter config plus CHAIN_RPC_URLS; see the SDK's
// evm-client.ts. This URL was `http://localhost:8545`, which no deployed
// browser can reach, and the omission of HyperEVM below meant wagmi had no
// entry for it whatsoever.
const flareCoston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://coston2-api.flare.network/ext/C/rpc"] },
    public: { http: ["https://coston2-api.flare.network/ext/C/rpc"] },
  },
  blockExplorers: {
    default: {
      name: "Coston2 Explorer",
      url: "https://coston2-explorer.flare.network",
    },
  },
});

const hyperEvmTestnet = defineChain({
  id: 998,
  name: "HyperEVM Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.hyperliquid-testnet.xyz/evm"] },
    public: { http: ["https://rpc.hyperliquid-testnet.xyz/evm"] },
  },
  blockExplorers: {
    default: { name: "Purrsec", url: "https://testnet.purrsec.com" },
  },
});

// Default chains that are always available
const defaultChains = [
  mainnet,
  sepolia,
  base,
  baseSepolia,
  optimism,
  optimismSepolia,
  flareCoston2,
  hyperEvmTestnet,
] as const;

// Create initial wagmi config with default chains only
const createWagmiConfig = (
  customChains: ReturnType<typeof defineChain>[] = [],
): Config => {
  const allChains = [...defaultChains, ...customChains] as const;

  // Create transports object dynamically with retry logic
  const transports: Record<number, ReturnType<typeof http>> = {};
  allChains.forEach((chain) => {
    transports[chain.id] = http(chain.rpcUrls.default.http[0], {
      batch: { batchSize: 1 }, // Disable batching to avoid connection issues
      retryCount: 3,
      retryDelay: 1000,
      timeout: 30000,
    });
  });

  return createConfig({
    chains: allChains,
    transports,
    connectors: [
      // Injected wallets (MetaMask, Rabby, etc.)
      injected(),
      // WalletConnect
      walletConnect({
        projectId,
        showQrModal: true,
        metadata: {
          name: "Terminal Exchange",
          description: "Terminal Exchange Trading Platform",
          url:
            typeof window !== "undefined"
              ? window.location.origin
              : "https://terminal.exchange",
          icons: [
            typeof window !== "undefined"
              ? `${window.location.origin}/favicon.png`
              : "",
          ],
        },
      }),
      // Coinbase Wallet
      coinbaseWallet({
        appName: "Terminal Exchange",
      }),
    ],
  });
};

// Lazy-initialized — avoids WalletConnect accessing indexedDB during SSR.
let _wagmiConfig: Config | null = null;

/** Returns the wagmi config, creating it on first access (client-side only). */
export function getWagmiConfig(): Config {
  if (!_wagmiConfig) {
    _wagmiConfig = createWagmiConfig();
  }
  return _wagmiConfig;
}

export { createWagmiConfig };

// NOTE: a `createDynamicChains` / `updateWagmiConfig` pair used to live here,
// intended to rebuild this config from the arborter's chain list. Nothing ever
// called it, and it could not have worked: it fed wagmi the `rpc_url` from
// GetConfig, which the arborter masks, and hardcoded every chain's native
// currency to ETH/18. Chain reads now bypass wagmi transports entirely
// (see the SDK's evm-client.ts), so it has been removed rather than fixed.

// Reset the config (useful for testing)
export const resetWagmiConfig = (): void => {
  _wagmiConfig = null;
};
