"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import { useExchangeStore } from "@/lib/store";
import { tronToHex } from "@aspensprotocol/sdk-ts";
import {
  walletRegistry,
  EvmWalletAdapter,
  SolanaWalletAdapter,
  TronWalletAdapter,
  TRON_WALLET_NAME,
  setSolanaWalletContext,
} from "@/lib/wallet";
import { useTronWallet } from "./tron-provider";
import { toast } from "sonner";

// Register adapters once
let registered = false;
function ensureAdaptersRegistered() {
  if (registered) return;
  walletRegistry.register(new EvmWalletAdapter());
  walletRegistry.register(new SolanaWalletAdapter());
  walletRegistry.register(new TronWalletAdapter());
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
  const tronWallet = useTronWallet();

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
  const prevTronRef = useRef<string | undefined>(undefined);

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

  // Sync the Tron wallet. The store keys it by its account as 0x hex, the
  // form the venue uses; the `T…` form is for display only.
  useEffect(() => {
    const tronAddress = tronWallet.address
      ? tronToHex(tronWallet.address)
      : undefined;
    const prevTronAddress = prevTronRef.current;
    prevTronRef.current = tronAddress;

    if (tronAddress) {
      // Same stale-entry retirement as the EVM effect above.
      if (prevTronAddress && prevTronAddress !== tronAddress) {
        const staleId = `tron:${prevTronAddress}`;
        if (connectedWallets[staleId]) {
          disconnectWallet(staleId);
        }
      }
      const walletId = `tron:${tronAddress}`;
      if (!connectedWallets[walletId]) {
        connectWallet({
          id: walletId,
          name: TRON_WALLET_NAME,
          address: tronAddress,
          ecosystem: "tron",
          icon: tronWallet.icon,
        });
        if (!prevTronAddress) {
          toast.success("Tron wallet connected");
        }
      }
    } else if (prevTronAddress) {
      const walletId = `tron:${prevTronAddress}`;
      if (connectedWallets[walletId]) {
        disconnectWallet(walletId);
      }
    }
  }, [
    tronWallet.address,
    tronWallet.icon,
    connectWallet,
    disconnectWallet,
    connectedWallets,
  ]);

  return null;
}
