"use client";

import { WagmiProvider as WagmiProviderBase } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getWagmiConfig } from "../web3modal-config";
import { SolanaProvider } from "./solana-provider";
import { WalletSync } from "./wallet-sync";
import { useState, useEffect, type ReactNode } from "react";
import type { Config } from "wagmi";

interface WagmiProviderProps {
  children: ReactNode;
}

export function WagmiProvider({ children }: WagmiProviderProps) {
  const [config, setConfig] = useState<Config | null>(null);

  // Create query client once per render tree
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  // Defer wagmi config creation to client-side only, avoiding
  // WalletConnect's indexedDB access during SSR. The setState-in-effect
  // is intentional: initial render (server + client hydration) must
  // match with config=null to avoid a hydration mismatch, and the
  // config only becomes available after first client mount.
  useEffect(() => {
    setConfig(getWagmiConfig()); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);

  // During SSR / before hydration, render nothing.
  // The LoadingScreen (rendered by Providers) covers this.
  if (!config) {
    return null;
  }

  return (
    <WagmiProviderBase config={config}>
      <QueryClientProvider client={queryClient}>
        <SolanaProvider>
          <WalletSync />
          {children}
        </SolanaProvider>
      </QueryClientProvider>
    </WagmiProviderBase>
  );
}
