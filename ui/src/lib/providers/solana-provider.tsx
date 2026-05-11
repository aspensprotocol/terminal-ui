"use client";

import { useMemo, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";

import "@solana/wallet-adapter-react-ui/styles.css";

const SOLANA_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

interface SolanaProviderProps {
  children: ReactNode;
}

// `wallets` is intentionally empty: Phantom, Solflare, Backpack and the
// rest of the modern Solana wallets implement the Wallet Standard
// (https://github.com/wallet-standard/wallet-standard) and are
// auto-discovered by `WalletProvider` through
// `@solana/wallet-standard-wallet-adapter-react` (transitive dep of
// `@solana/wallet-adapter-react`). Passing them explicitly via
// `new PhantomWalletAdapter()` registers a *legacy* adapter that talks
// to the deprecated `window.solana` injection, which Phantom no longer
// exposes — the modal closes on click but no extension popup fires and
// no error surfaces. Auto-discovery picks up the same wallet through
// the live wallet-standard channel and connects normally.
export function SolanaProvider({ children }: SolanaProviderProps) {
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
