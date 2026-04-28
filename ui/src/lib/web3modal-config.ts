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
import { type Chain as ViemChain, defineChain } from "viem";

// WalletConnect project ID - you should get your own at https://cloud.walletconnect.com
const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  "c3690594c774dccbd4a0272ae38f1953";

// Flare Coston2 — also covers the local anvil-fork dev setup where two
// "networks" (flare-coston2 and flare-coston2-quote) share chainId 114
// and run on adjacent ports. wagmi keys by chainId, so a single entry
// is enough for the connector to accept the chain when MetaMask is on
// it. Actual chain reads in the gasless flow go via the per-network
// rpcUrl from arborter's Configuration, not via wagmi's transports.
const flareCoston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: {
    default: { http: ["http://localhost:8545"] },
    public: { http: ["http://localhost:8545"] },
  },
  blockExplorers: {
    default: {
      name: "Coston2 Explorer",
      url: "https://coston2-explorer.flare.network",
    },
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

// Chain configuration from gRPC backend
export interface GrpcChain {
  chainId: number;
  network: string;
  rpcUrl: string;
  explorerUrl?: string;
}

// Utility function to create dynamic chains from gRPC config
export const createDynamicChains = (grpcChains: GrpcChain[]): ViemChain[] => {
  return grpcChains.map((chain) =>
    defineChain({
      id: chain.chainId,
      name: chain.network,
      network: chain.network,
      nativeCurrency: {
        decimals: 18,
        name: "Ether",
        symbol: "ETH",
      },
      rpcUrls: {
        default: { http: [chain.rpcUrl] },
        public: { http: [chain.rpcUrl] },
      },
      blockExplorers: chain.explorerUrl
        ? {
            default: { name: "Explorer", url: chain.explorerUrl },
          }
        : undefined,
    }),
  );
};

// Track if we've already updated the config to prevent multiple initializations
let hasUpdatedConfig = false;

// Function to update the wagmi config with chains from gRPC config
export const updateWagmiConfig = (grpcChains: GrpcChain[]): Config => {
  if (hasUpdatedConfig) {
    return getWagmiConfig();
  }

  const dynamicChains = createDynamicChains(grpcChains);
  _wagmiConfig = createWagmiConfig(dynamicChains);
  hasUpdatedConfig = true;

  return _wagmiConfig;
};

// Reset the config (useful for testing)
export const resetWagmiConfig = (): void => {
  hasUpdatedConfig = false;
  _wagmiConfig = null;
};
