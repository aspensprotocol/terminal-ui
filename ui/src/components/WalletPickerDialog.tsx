"use client";

/**
 * The one wallet pane: every connected wallet across ecosystems on top, and
 * below it one row per wallet product with a chain mark per leg it supports.
 * Phantom is a single row with EVM and Solana marks, not two rows.
 *
 * Opened through `useWalletPickerStore`; the header trigger and the trade
 * panel's missing-wallet CTA both route here.
 */

import { useMemo, useState } from "react";
import { useConnectors } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import { CheckCircle2, Copy, LogOut, Wallet } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useExchangeStore } from "@/lib/store";
import { walletRegistry } from "@/lib/wallet";
import { useWalletPickerStore } from "@/lib/wallet/picker-store";
import {
  mergeWalletProviders,
  type SolanaReadyState,
  type WalletProviderRow,
} from "@/lib/wallet/providers";
import { useWalletConnect } from "@/lib/hooks/useWalletConnect";
import type { ChainEcosystem, ConnectedWallet } from "@/lib/wallet/types";

export function shortenAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function ecosystemLabel(ecosystem: ChainEcosystem): string {
  switch (ecosystem) {
    case "evm":
      return "EVM";
    case "solana":
      return "SOL";
    default:
      return ecosystem;
  }
}

/** The chain mark for an ecosystem leg. Dark-only app; see ChainLogo. */
const ECOSYSTEM_MARK: Record<ChainEcosystem, string> = {
  evm: "/chain-logos/1-dark.png",
  solana: "/chain-logos/solana-dark.png",
};

function EcosystemMark({
  ecosystem,
  onClick,
  title,
}: {
  ecosystem: ChainEcosystem;
  onClick?: () => void;
  title: string;
}) {
  const inner = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={ECOSYSTEM_MARK[ecosystem]}
        alt=""
        className="h-4 w-4 rounded-[2px]"
      />
      <span className="text-[10px] font-semibold uppercase tracking-wide">
        {ecosystemLabel(ecosystem)}
      </span>
    </>
  );
  const base =
    "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-muted-foreground";
  if (!onClick) {
    return (
      <span className={`${base} border-border/60`} title={title}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      className={`${base} border-border/60 transition-colors hover:border-primary/60 hover:bg-primary/10 hover:text-foreground`}
    >
      {inner}
    </button>
  );
}

function ConnectedRow({
  wallet,
  active,
  onActivate,
  onDisconnect,
}: {
  wallet: ConnectedWallet;
  active: boolean;
  onActivate: () => void;
  onDisconnect: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      toast.success("Address copied!");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy address");
    }
  };

  return (
    <div
      role={active ? undefined : "button"}
      tabIndex={active ? undefined : 0}
      onClick={active ? undefined : onActivate}
      onKeyDown={(e) => {
        if (!active && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onActivate();
        }
      }}
      className={`flex items-center justify-between gap-2 rounded-md px-2 py-2 text-xs ${
        active
          ? "border border-primary/30 bg-primary/10"
          : "cursor-pointer border border-transparent hover:bg-muted/50"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {wallet.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={wallet.icon} alt="" className="h-5 w-5 rounded" />
        ) : (
          <Wallet className="h-5 w-5 text-muted-foreground" />
        )}
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{wallet.name}</span>
          <span className="flex items-center gap-1.5 font-mono text-muted-foreground">
            <span className="text-[10px] font-semibold uppercase text-primary/60">
              {ecosystemLabel(wallet.ecosystem)}
            </span>
            {shortenAddress(wallet.address)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {active ? (
          <span className="mr-1 text-[10px] font-medium text-primary">
            Active
          </span>
        ) : (
          <span className="mr-1 text-[10px] text-muted-foreground">Use</span>
        )}
        <button
          type="button"
          onClick={copy}
          title="Copy address"
          className="rounded p-1 transition-colors hover:bg-muted"
        >
          {copied ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDisconnect();
          }}
          title="Disconnect"
          className="rounded p-1 transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function ProviderRow({
  row,
  onConnect,
}: {
  row: WalletProviderRow;
  onConnect: (ecosystem: ChainEcosystem) => void;
}) {
  const legs: ChainEcosystem[] = [];
  if (row.evm) legs.push("evm");
  if (row.solana) legs.push("solana");
  const single = legs.length === 1 ? legs[0] : undefined;

  const notInstalledSolana =
    row.solana && row.solana.readyState === "NotDetected";

  return (
    <div
      role={single ? "button" : undefined}
      tabIndex={single ? 0 : undefined}
      onClick={single ? () => onConnect(single) : undefined}
      onKeyDown={(e) => {
        if (single && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onConnect(single);
        }
      }}
      className={`flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm transition-colors ${
        single ? "cursor-pointer hover:bg-muted/50" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        {row.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.icon} alt="" className="h-7 w-7 rounded-md" />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted">
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </span>
        )}
        <span className="truncate font-medium">{row.name}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {row.installed && (
          <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Installed
          </span>
        )}
        {!row.installed && notInstalledSolana && !row.evm && (
          <span className="text-[10px] text-muted-foreground">Install</span>
        )}
        {legs.map((leg) => (
          <EcosystemMark
            key={leg}
            ecosystem={leg}
            title={`Connect ${row.name} for ${ecosystemLabel(leg)}`}
            onClick={single ? undefined : () => onConnect(leg)}
          />
        ))}
      </div>
    </div>
  );
}

export function WalletPickerDialog() {
  const isOpen = useWalletPickerStore((s) => s.isOpen);
  const filter = useWalletPickerStore((s) => s.ecosystem);
  const close = useWalletPickerStore((s) => s.close);

  const connectors = useConnectors();
  const { wallets: solanaWallets } = useWallet();
  const { connectEvm, connectSolana } = useWalletConnect();

  const connectedWallets = useExchangeStore((s) => s.connectedWallets);
  const activeWalletId = useExchangeStore((s) => s.activeWalletId);
  const setActiveWallet = useExchangeStore((s) => s.setActiveWallet);
  const disconnectWallet = useExchangeStore((s) => s.disconnectWallet);

  const connected = useMemo(
    () => Object.values(connectedWallets),
    [connectedWallets],
  );

  const rows = useMemo(
    () =>
      mergeWalletProviders(
        connectors,
        solanaWallets.map((w) => ({
          name: w.adapter.name,
          icon: w.adapter.icon,
          url: w.adapter.url,
          readyState: String(w.readyState) as SolanaReadyState,
        })),
        {
          filter,
          hasInjectedProvider:
            typeof window !== "undefined" && "ethereum" in window,
        },
      ),
    [connectors, solanaWallets, filter],
  );

  const handleConnect = (row: WalletProviderRow, ecosystem: ChainEcosystem) => {
    close();
    if (ecosystem === "evm" && row.evm) {
      void connectEvm(row.evm.connectorId);
    } else if (ecosystem === "solana" && row.solana) {
      connectSolana(row.solana.walletName);
    }
  };

  const handleDisconnect = async (wallet: ConnectedWallet) => {
    try {
      const adapter = walletRegistry.getAdapter(wallet.ecosystem);
      if (adapter) {
        await adapter.disconnect(wallet.address);
      }
      disconnectWallet(wallet.id);
      toast.success(`${wallet.name} disconnected`);
    } catch {
      // Still remove from store even if adapter disconnect fails
      disconnectWallet(wallet.id);
    }
  };

  const handleActivate = (wallet: ConnectedWallet) => {
    setActiveWallet(wallet.id);
    toast.success("Switched active wallet");
  };

  const title = filter
    ? `Connect a ${filter === "solana" ? "Solana" : "EVM"} wallet`
    : "Wallets";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md bg-card/95 backdrop-blur-xl border-border/50">
        <DialogHeader>
          <DialogTitle className="text-xl text-foreground">{title}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {filter
              ? "The selected market settles on this chain family."
              : "One wallet per ecosystem; the active one signs orders."}
          </DialogDescription>
        </DialogHeader>

        {!filter && (
          <section className="space-y-1">
            <h3 className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Connected
            </h3>
            {connected.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                No wallets connected.
              </p>
            ) : (
              connected.map((w) => (
                <ConnectedRow
                  key={w.id}
                  wallet={w}
                  active={w.id === activeWalletId}
                  onActivate={() => handleActivate(w)}
                  onDisconnect={() => handleDisconnect(w)}
                />
              ))
            )}
          </section>
        )}

        <section className="space-y-1">
          <h3 className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {filter ? "Wallets" : "Connect a wallet"}
          </h3>
          <div className="max-h-[50vh] overflow-y-auto">
            {rows.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                No wallet providers detected.
              </p>
            ) : (
              rows.map((row) => (
                <ProviderRow
                  key={row.key}
                  row={row}
                  onConnect={(eco) => handleConnect(row, eco)}
                />
              ))
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
