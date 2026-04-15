"use client";

/**
 * Deposit / withdraw dialog.
 *
 * Single entry point for moving tokens between the user's wallet and
 * the arborter's trade contract. The underlying hook dispatches on
 * chain architecture (EVM: wagmi + MidribV2 calls, Solana: web3.js +
 * Midrib program instructions), so the dialog itself is
 * ecosystem-agnostic — the (chain, token) picker simply enumerates
 * every chain the arborter exposes.
 *
 * Shows live balances for the selected (chain, token) — wallet balance
 * (source for deposit) and deposited / locked (source for withdraw) —
 * so the user has the context they need to pick an amount, plus a Max
 * button that autofills from whichever side is the source.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Wallet } from "lucide-react";
import type { ChainBalanceSlice } from "@exchange/sdk";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useExchangeStore } from "@/lib/store";
import { useExchangeClient } from "@/lib/hooks/useExchangeClient";
import { useDepositWithdraw } from "@/lib/hooks/useDepositWithdraw";

interface TransferDialogProps {
  /** If true, dialog is controlled externally via open/onOpenChange. */
  controlled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
}

/** Token row in the picker: "USDC on base-sepolia". */
interface TokenChoice {
  chainNetwork: string;
  tokenTicker: string;
  tokenAddress: string;
  decimals: number;
  architecture: string;
}

type Mode = "deposit" | "withdraw";

export function TransferDialog({
  controlled = false,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  trigger,
}: TransferDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  const chainBalanceSlices = useExchangeStore(
    (state) => state.chainBalanceSlices,
  );
  const client = useExchangeClient();
  const { deposit, withdraw, pending } = useDepositWithdraw();

  const open = controlled ? (externalOpen ?? false) : internalOpen;
  const setOpen = controlled
    ? (externalOnOpenChange ?? (() => {}))
    : setInternalOpen;

  // Every (chain, token) pair the arborter knows about. We intentionally
  // enumerate per chain rather than aggregating — a user deposits into
  // one specific chain, not "all chains".
  const tokenChoices = useMemo<TokenChoice[]>(() => {
    const config = client.cache.getConfig();
    if (!config) return [];
    const out: TokenChoice[] = [];
    for (const chain of config.chains) {
      // Only list chains whose architecture we can actually drive.
      // Hedera (and anything else) doesn't have a Transfer wire-up yet.
      if (!chain.architecture.match(/^(evm|solana)$/i)) continue;
      for (const [ticker, token] of Object.entries(chain.tokens)) {
        out.push({
          chainNetwork: chain.network,
          tokenTicker: ticker,
          tokenAddress: token.address,
          decimals: token.decimals,
          architecture: chain.architecture,
        });
      }
    }
    return out;
  }, [client]);

  const [choiceKey, setChoiceKey] = useState<string>("");
  const [amountInput, setAmountInput] = useState<string>("");
  const [mode, setMode] = useState<Mode>("deposit");

  const choice = tokenChoices.find(
    (c) => `${c.chainNetwork}::${c.tokenTicker}` === choiceKey,
  );

  const slice: ChainBalanceSlice | undefined = useMemo(() => {
    if (!choice) return undefined;
    return chainBalanceSlices.find(
      (s) =>
        s.chainNetwork === choice.chainNetwork &&
        s.tokenTicker === choice.tokenTicker,
    );
  }, [chainBalanceSlices, choice]);

  // Reset amount when the token changes — carrying over an amount from
  // one token's decimals to another's is a footgun.
  useEffect(() => {
    setAmountInput("");
  }, [choiceKey, mode]);

  const handleSubmit = async () => {
    if (!choice) return;
    const parsed = Number(amountInput);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    const amount = BigInt(Math.round(parsed * Math.pow(10, choice.decimals)));
    const params = {
      chainNetwork: choice.chainNetwork,
      tokenTicker: choice.tokenTicker,
      amount,
    };
    try {
      if (mode === "deposit") await deposit(params);
      else await withdraw(params);
      setAmountInput("");
    } catch {
      // error surfaced via toast in the hook
    }
  };

  const defaultTrigger = (
    <Button size="sm" variant="outline" className="gap-2">
      <Wallet className="h-4 w-4" />
      Transfer
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>{trigger ?? defaultTrigger}</DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md bg-card/95 backdrop-blur-xl border-border/50">
        <DialogHeader>
          <DialogTitle className="text-xl text-foreground">
            Transfer
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isAuthenticated
              ? "Move tokens between your wallet and the trade contract."
              : "Connect a wallet to deposit or withdraw."}
          </DialogDescription>
        </DialogHeader>

        {!isAuthenticated ? (
          <div className="flex flex-col items-center gap-4 py-6">
            <p className="text-sm text-muted-foreground text-center">
              Connect a wallet in the header to transfer.
            </p>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </div>
        ) : (
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as Mode)}
            className="w-full"
          >
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="deposit" className="gap-2">
                <ArrowDownToLine className="h-4 w-4" />
                Deposit
              </TabsTrigger>
              <TabsTrigger value="withdraw" className="gap-2">
                <ArrowUpFromLine className="h-4 w-4" />
                Withdraw
              </TabsTrigger>
            </TabsList>

            <TabsContent value="deposit" className="space-y-4 pt-4">
              <TransferForm
                choices={tokenChoices}
                choice={choice}
                choiceKey={choiceKey}
                setChoiceKey={setChoiceKey}
                slice={slice}
                amount={amountInput}
                setAmount={setAmountInput}
                pending={pending}
                mode="deposit"
                onSubmit={handleSubmit}
              />
            </TabsContent>
            <TabsContent value="withdraw" className="space-y-4 pt-4">
              <TransferForm
                choices={tokenChoices}
                choice={choice}
                choiceKey={choiceKey}
                setChoiceKey={setChoiceKey}
                slice={slice}
                amount={amountInput}
                setAmount={setAmountInput}
                pending={pending}
                mode="withdraw"
                onSubmit={handleSubmit}
              />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface TransferFormProps {
  choices: TokenChoice[];
  choice: TokenChoice | undefined;
  choiceKey: string;
  setChoiceKey: (v: string) => void;
  slice: ChainBalanceSlice | undefined;
  amount: string;
  setAmount: (v: string) => void;
  pending: boolean;
  mode: Mode;
  onSubmit: () => void;
}

function TransferForm({
  choices,
  choice,
  choiceKey,
  setChoiceKey,
  slice,
  amount,
  setAmount,
  pending,
  mode,
  onSubmit,
}: TransferFormProps) {
  const actionLabel = mode === "deposit" ? "Deposit" : "Withdraw";

  // Pick the "source" side for the Max button. Deposits pull from the
  // user's wallet; withdraws pull from the deposited-minus-locked
  // (available) slice of the trade contract.
  const sourceRaw: bigint | undefined = slice
    ? mode === "deposit"
      ? slice.wallet
      : slice.deposited - slice.locked
    : undefined;

  const sourceDisplay = slice
    ? formatRaw(sourceRaw ?? 0n, slice.tokenDecimals)
    : null;

  const setMax = () => {
    if (!choice || !slice) return;
    setAmount(formatRaw(sourceRaw ?? 0n, slice.tokenDecimals));
  };

  const disabled =
    !choiceKey ||
    pending ||
    !amount.trim() ||
    !Number.isFinite(Number(amount)) ||
    Number(amount) <= 0;

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="transfer-token" className="text-sm font-medium">
          Token
        </Label>
        <Select value={choiceKey} onValueChange={setChoiceKey}>
          <SelectTrigger id="transfer-token" className="w-full">
            <SelectValue placeholder="Choose a token + chain…" />
          </SelectTrigger>
          <SelectContent>
            {choices.map((c) => (
              <SelectItem
                key={`${c.chainNetwork}::${c.tokenTicker}`}
                value={`${c.chainNetwork}::${c.tokenTicker}`}
              >
                <span className="font-semibold">{c.tokenTicker}</span>
                <span className="text-muted-foreground text-xs ml-2">
                  on {c.chainNetwork}
                </span>
              </SelectItem>
            ))}
            {choices.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No supported chains configured yet.
              </div>
            )}
          </SelectContent>
        </Select>
      </div>

      {choice && slice && <BalanceSummary slice={slice} mode={mode} />}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="transfer-amount" className="text-sm font-medium">
            Amount
          </Label>
          {choice && sourceDisplay !== null && (
            <button
              type="button"
              onClick={setMax}
              className="text-xs text-primary hover:underline"
            >
              Max: {sourceDisplay}
            </button>
          )}
        </div>
        <Input
          id="transfer-amount"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>

      <Button
        onClick={onSubmit}
        disabled={disabled}
        className="w-full"
        size="lg"
      >
        {pending ? "Submitting…" : actionLabel}
      </Button>
    </>
  );
}

function BalanceSummary({
  slice,
  mode,
}: {
  slice: ChainBalanceSlice;
  mode: Mode;
}) {
  const wallet = formatRaw(slice.wallet, slice.tokenDecimals);
  const deposited = formatRaw(slice.deposited, slice.tokenDecimals);
  const locked = formatRaw(slice.locked, slice.tokenDecimals);
  const available = formatRaw(
    slice.deposited - slice.locked,
    slice.tokenDecimals,
  );
  return (
    <div className="rounded-md border border-border/40 bg-background/40 text-xs divide-y divide-border/40">
      <Row label="Wallet" value={wallet} emphasis={mode === "deposit"} />
      <Row
        label="Deposited (available)"
        value={available}
        emphasis={mode === "withdraw"}
      />
      <Row label="Locked in open orders" value={locked} muted />
      {deposited !== available && (
        <Row label="Deposited (total)" value={deposited} muted />
      )}
    </div>
  );
}

function Row({
  label,
  value,
  emphasis,
  muted,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className={muted ? "text-muted-foreground" : "text-foreground/80"}>
        {label}
      </span>
      <span
        className={
          emphasis
            ? "font-medium text-foreground"
            : muted
              ? "text-muted-foreground"
              : "text-foreground/80"
        }
      >
        {value}
      </span>
    </div>
  );
}

/** Format a raw bigint amount using the token's decimals. Trim trailing zeros. */
function formatRaw(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}
