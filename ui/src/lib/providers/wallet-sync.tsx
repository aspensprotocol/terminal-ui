"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import { useExchangeStore } from "@/lib/store";
import {
  walletRegistry,
  EvmWalletAdapter,
  SolanaWalletAdapter,
  setSolanaWalletContext,
} from "@/lib/wallet";
import { toast } from "sonner";

// Register adapters once
let registered = false;
function ensureAdaptersRegistered() {
  if (registered) return;
  walletRegistry.register(new EvmWalletAdapter());
  walletRegistry.register(new SolanaWalletAdapter());
  registered = true;
}

export function WalletSync() {
  ensureAdaptersRegistered();

  const {
    address: evmAddress,
    isConnected: evmConnected,
    connector: evmConnector,
  } = useAccount();
  const solanaWallet = useWallet();

  const connectWallet = useExchangeStore((state) => state.connectWallet);
  const disconnectWallet = useExchangeStore((state) => state.disconnectWallet);
  const connectedWallets = useExchangeStore((state) => state.connectedWallets);

  // Keep Solana wallet context reference up to date
  useEffect(() => {
    setSolanaWalletContext(solanaWallet);
  }, [solanaWallet]);

  // Track previous values to detect changes
  const prevEvmRef = useRef<string | undefined>(undefined);
  const prevSolanaRef = useRef<string | undefined>(undefined);

  // Sync EVM wallet
  useEffect(() => {
    const prevEvmAddress = prevEvmRef.current;
    prevEvmRef.current = evmAddress;

    if (evmConnected && evmAddress) {
      // An account SWITCH (still connected, address changed) must retire
      // the previous entry: a stale same-ecosystem wallet left in the
      // store is one every "find a wallet of this ecosystem" consumer —
      // settlement defaults included — can silently land on.
      if (prevEvmAddress && prevEvmAddress !== evmAddress) {
        const staleId = `evm:${prevEvmAddress}`;
        if (connectedWallets[staleId]) {
          disconnectWallet(staleId);
        }
      }
      const walletId = `evm:${evmAddress}`;
      if (!connectedWallets[walletId]) {
        connectWallet({
          id: walletId,
          name: evmConnector?.name ?? "EVM Wallet",
          address: evmAddress,
          ecosystem: "evm",
          icon: evmConnector?.icon,
        });
        if (!prevEvmAddress) {
          toast.success("EVM wallet connected");
        }
      }
    } else if (!evmConnected && prevEvmAddress) {
      const walletId = `evm:${prevEvmAddress}`;
      if (connectedWallets[walletId]) {
        disconnectWallet(walletId);
      }
    }
  }, [
    evmConnected,
    evmAddress,
    evmConnector,
    connectWallet,
    disconnectWallet,
    connectedWallets,
  ]);

  // Sync Solana wallet
  useEffect(() => {
    const solanaAddress = solanaWallet.publicKey?.toBase58();
    const prevSolanaAddress = prevSolanaRef.current;
    prevSolanaRef.current = solanaAddress;

    if (solanaWallet.connected && solanaAddress) {
      // Same stale-entry retirement as the EVM effect above.
      if (prevSolanaAddress && prevSolanaAddress !== solanaAddress) {
        const staleId = `solana:${prevSolanaAddress}`;
        if (connectedWallets[staleId]) {
          disconnectWallet(staleId);
        }
      }
      const walletId = `solana:${solanaAddress}`;
      if (!connectedWallets[walletId]) {
        connectWallet({
          id: walletId,
          name: solanaWallet.wallet?.adapter.name ?? "Solana Wallet",
          address: solanaAddress,
          ecosystem: "solana",
          icon: solanaWallet.wallet?.adapter.icon,
        });
        if (!prevSolanaAddress) {
          toast.success("Solana wallet connected");
        }
      }
    } else if (!solanaWallet.connected && prevSolanaAddress) {
      const walletId = `solana:${prevSolanaAddress}`;
      if (connectedWallets[walletId]) {
        disconnectWallet(walletId);
      }
    }
  }, [
    solanaWallet.connected,
    solanaWallet.publicKey,
    solanaWallet.wallet,
    connectWallet,
    disconnectWallet,
    connectedWallets,
  ]);

  return null;
}
