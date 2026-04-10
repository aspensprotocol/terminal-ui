/**
 * Shared hook exposing connect handlers for each wallet ecosystem.
 * Used by WalletManager and TradePanel so they share a single entry point.
 */

import { useCallback } from "react";
import { useConnect } from "wagmi";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { toast } from "sonner";

export function useWalletConnect() {
  const { connect, connectors } = useConnect();
  const { setVisible: setSolanaModalVisible } = useWalletModal();

  const connectEvm = useCallback(() => {
    const injectedConnector = connectors.find((c) => c.id === "injected");
    const connector = injectedConnector || connectors[0];
    if (connector) {
      connect({ connector });
    } else {
      toast.error("No EVM wallet connector available");
    }
  }, [connect, connectors]);

  const connectSolana = useCallback(() => {
    setSolanaModalVisible(true);
  }, [setSolanaModalVisible]);

  return { connectEvm, connectSolana };
}
