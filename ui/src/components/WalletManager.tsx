"use client";

import { useMemo, useState } from "react";
import { useExchangeStore } from "@/lib/store";
import { walletRegistry } from "@/lib/wallet";
import { useWalletConnect } from "@/lib/hooks/useWalletConnect";
import { Button } from "@/components/ui/button";
import { Copy, CheckCircle2, LogOut, Wallet, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import type { ChainEcosystem } from "@/lib/wallet/types";

function shortenAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function ecosystemLabel(ecosystem: ChainEcosystem): string {
  switch (ecosystem) {
    case "evm":
      return "EVM";
    case "solana":
      return "SOL";
    default:
      return ecosystem;
  }
}

export function WalletManager() {
  const { connectEvm: handleConnectEvm, connectSolana: handleConnectSolana } =
    useWalletConnect();

  const connectedWallets = useExchangeStore((state) => state.connectedWallets);
  const activeWalletId = useExchangeStore((state) => state.activeWalletId);
  const setActiveWallet = useExchangeStore((state) => state.setActiveWallet);
  const disconnectWallet = useExchangeStore((state) => state.disconnectWallet);

  const walletList = useMemo(
    () => Object.values(connectedWallets),
    [connectedWallets],
  );
  const activeWallet = activeWalletId ? connectedWallets[activeWalletId] : null;

  const [copied, setCopied] = useState(false);
  const [showWalletList, setShowWalletList] = useState(false);

  const handleDisconnect = async (walletId: string) => {
    const wallet = connectedWallets[walletId];
    if (!wallet) return;

    try {
      const adapter = walletRegistry.getAdapter(wallet.ecosystem);
      if (adapter) {
        await adapter.disconnect(wallet.address);
      }
      disconnectWallet(walletId);
      toast.success(`${wallet.name} disconnected`);
    } catch {
      // Still remove from store even if adapter disconnect fails
      disconnectWallet(walletId);
    }
    setShowWalletList(false);
  };

  const handleCopyAddress = async () => {
    if (!activeWallet) return;
    try {
      await navigator.clipboard.writeText(activeWallet.address);
      setCopied(true);
      toast.success("Address copied!");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy address");
    }
  };

  const handleSwitchWallet = (walletId: string) => {
    setActiveWallet(walletId);
    setShowWalletList(false);
    toast.success("Switched active wallet");
  };

  // No wallets connected
  if (walletList.length === 0) {
    return (
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="default"
          className="gap-1.5 backdrop-blur-md bg-primary/80 hover:bg-primary/90 border-b-[3px] border-b-primary shadow-[0_3px_2px_0px_rgba(0,66,37,0.8),0_1px_1px_0px_rgba(255,255,255,0.5)] cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:shadow-[0_4px_6px_0px_rgba(0,66,37,0.85),0_1px_2px_0px_rgba(255,255,255,0.6)] active:scale-[0.98]"
          onClick={handleConnectEvm}
        >
          <Wallet className="h-4 w-4" />
          Connect EVM
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 transition-all duration-200 hover:scale-[1.02] hover:shadow-md hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98]"
          onClick={handleConnectSolana}
        >
          <Wallet className="h-4 w-4" />
          Connect Solana
        </Button>
      </div>
    );
  }

  // Has connected wallet(s)
  return (
    <div className="flex items-center gap-2 relative">
      {/* Active wallet pill */}
      <Button
        size="sm"
        variant="outline"
        onClick={handleCopyAddress}
        className="gap-2 transition-all duration-200 hover:scale-[1.02] hover:shadow-md hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98]"
      >
        <Wallet className="h-3.5 w-3.5 text-primary/70" />
        <span className="text-[10px] font-semibold text-primary/60 uppercase">
          {activeWallet ? ecosystemLabel(activeWallet.ecosystem) : ""}
        </span>
        <span className="font-mono text-xs">
          {activeWallet ? shortenAddress(activeWallet.address) : ""}
        </span>
        {copied ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </Button>

      {/* Wallet switcher / manage button */}
      <div className="relative">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowWalletList(!showWalletList)}
          className="gap-1 transition-all duration-200 hover:scale-[1.02] hover:shadow-md hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98]"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          {walletList.length > 1 && (
            <span className="text-xs text-muted-foreground">
              {walletList.length}
            </span>
          )}
        </Button>

        {/* Wallet list dropdown */}
        {showWalletList && (
          <>
            {/* Backdrop to close */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setShowWalletList(false)}
            />
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[280px] bg-card/95 backdrop-blur-xl border border-border rounded-md shadow-lg p-2 space-y-1">
              {/* Connected wallets */}
              {walletList.map((wallet) => (
                <div
                  key={wallet.id}
                  className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded text-xs ${
                    wallet.id === activeWalletId
                      ? "bg-primary/10 border border-primary/30"
                      : "hover:bg-muted/50 cursor-pointer"
                  }`}
                  onClick={() =>
                    wallet.id !== activeWalletId &&
                    handleSwitchWallet(wallet.id)
                  }
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {wallet.icon && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={wallet.icon}
                        alt=""
                        className="h-4 w-4 rounded"
                      />
                    )}
                    <span className="font-semibold text-primary/60 uppercase text-[10px]">
                      {ecosystemLabel(wallet.ecosystem)}
                    </span>
                    <span className="font-mono truncate">
                      {shortenAddress(wallet.address)}
                    </span>
                    {wallet.id === activeWalletId && (
                      <span className="text-[10px] text-primary font-medium">
                        Active
                      </span>
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDisconnect(wallet.id);
                    }}
                    className="p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-colors"
                  >
                    <LogOut className="h-3 w-3" />
                  </button>
                </div>
              ))}

              {/* Connect more wallets */}
              <div className="border-t border-border pt-1 mt-1 flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1 text-xs h-7 gap-1"
                  onClick={() => {
                    setShowWalletList(false);
                    handleConnectEvm();
                  }}
                >
                  + EVM
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1 text-xs h-7 gap-1"
                  onClick={() => {
                    setShowWalletList(false);
                    handleConnectSolana();
                  }}
                >
                  + Solana
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
