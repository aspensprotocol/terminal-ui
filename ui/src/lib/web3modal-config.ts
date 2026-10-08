import { type Config, createConfig, http } from "wagmi";
import {
  arbitrum,
  base,
  baseSepolia,
  flare,
  hyperEvm,
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
} from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { defineChain } from "viem";
import { PUBLIC_RPC_URLS } from "@aspens/terminal-sdk";

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
// withdraw do not read through wagmi's transports — they build a client from
// the arborter config, CHAIN_RPC_URLS and the SDK's public list; see the
// SDK's evm-client.ts. Keep the RPC URLs here publicly reachable all the same
// (a localhost URL is useless to a deployed browser), and give every chain
// the venue trades on an entry, or wagmi has nothing to accept the wallet's
// network against.
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

// Robinhood Chain and Arc are not in wagmi/chains yet. Their RPC is the
// SDK's public endpoint for the chain, so the two lists cannot drift.
function publicRpc(chainId: number): string {
  const url = PUBLIC_RPC_URLS.evm[chainId];
  if (!url) throw new Error(`No public RPC for chain ${chainId}`);
  return url;
}

const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [publicRpc(4663)] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

// Arc's gas token is USDC, 18 decimals as native (its ERC-20 face is 6).
const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [publicRpc(5042)] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});

// Default chains that are always available. The beta-1 mainnet venue trades
// on Ethereum, Base, Arbitrum, HyperEVM, Robinhood, Arc and Flare.
const defaultChains = [
  mainnet,
  sepolia,
  base,
  baseSepolia,
  optimism,
  optimismSepolia,
  arbitrum,
  hyperEvm,
  robinhood,
  arc,
  flare,
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

// This config is static on purpose. Rebuilding it from the arborter's chain
// list would feed wagmi the `rpcs[].url` values from GetConfig, which the
// arborter masks, and chain reads bypass wagmi transports anyway (see the
// SDK's evm-client.ts).
