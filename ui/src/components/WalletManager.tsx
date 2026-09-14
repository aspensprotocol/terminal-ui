"use client";

/**
 * The header's wallet control: one trigger that opens the unified picker.
 * With nothing connected it reads "Connect Wallets"; otherwise it shows the
 * active wallet and a count of every connected one. All management —
 * switching, copying, disconnecting, adding — lives in the dialog.
 */

import { useMemo } from "react";
import { useExchangeStore } from "@/lib/store";
import { useWalletPickerStore } from "@/lib/wallet/picker-store";
import { Button } from "@/components/ui/button";
import { Wallet, ChevronDown } from "lucide-react";
import {
  WalletPickerDialog,
  ecosystemLabel,
  shortenAddress,
} from "@/components/WalletPickerDialog";

export function WalletManager() {
  const openPicker = useWalletPickerStore((s) => s.open);
  const connectedWallets = useExchangeStore((state) => state.connectedWallets);
  const activeWalletId = useExchangeStore((state) => state.activeWalletId);

  const count = useMemo(
    () => Object.keys(connectedWallets).length,
    [connectedWallets],
  );
  const activeWallet = activeWalletId ? connectedWallets[activeWalletId] : null;

  return (
    <>
      {count === 0 || !activeWallet ? (
        <Button
          size="sm"
          variant="default"
          className="gap-1.5 backdrop-blur-md bg-primary/80 hover:bg-primary/90 border-b-[3px] border-b-primary shadow-[0_3px_2px_0px_rgba(0,66,37,0.8),0_1px_1px_0px_rgba(255,255,255,0.5)] cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:shadow-[0_4px_6px_0px_rgba(0,66,37,0.85),0_1px_2px_0px_rgba(255,255,255,0.6)] active:scale-[0.98]"
          onClick={() => openPicker()}
        >
          <Wallet className="h-4 w-4" />
          Connect Wallets
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openPicker()}
          className="gap-2 transition-all duration-200 hover:scale-[1.02] hover:shadow-md hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98]"
        >
          <Wallet className="h-3.5 w-3.5 text-primary/70" />
          <span className="text-[10px] font-semibold text-primary/60 uppercase">
            {ecosystemLabel(activeWallet.ecosystem)}
          </span>
          <span className="font-mono text-xs">
            {shortenAddress(activeWallet.address)}
          </span>
          {count > 1 && (
            <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">
              {count}
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      )}
      <WalletPickerDialog />
    </>
  );
}
