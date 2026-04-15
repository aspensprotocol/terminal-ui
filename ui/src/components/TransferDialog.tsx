"use client";

/**
 * Deposit / withdraw dialog.
 *
 * Single entry point for moving tokens between the user's wallet and
 * the arborter's trade contract, covering the two flows the UI has to
 * support end-to-end before trading is fully functional. Tabs split
 * the flows; a chain + token picker drives the balances / button text.
 *
 * Solana chains are filtered out for now — their deposit / withdraw
 * goes through the Midrib program via @solana/web3.js instead of
 * viem's writeContract and will ship in a follow-up.
 */

import { useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Wallet } from "lucide-react";
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

export function TransferDialog({
  controlled = false,
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  trigger,
}: TransferDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
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
      // Filter to EVM until the Solana UI wire-up lands.
      if (!chain.architecture.match(/^evm$/i)) continue;
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
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");

  const choice = tokenChoices.find(
    (c) => `${c.chainNetwork}::${c.tokenTicker}` === choiceKey,
  );

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
              Connect an EVM wallet in the header to transfer.
            </p>
            <Button onClick={() => setOpen(false)}>Close</Button>
          </div>
        ) : (
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as "deposit" | "withdraw")}
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
                choiceKey={choiceKey}
                setChoiceKey={setChoiceKey}
                amount={amountInput}
                setAmount={setAmountInput}
                pending={pending}
                actionLabel="Deposit"
                onSubmit={handleSubmit}
              />
            </TabsContent>
            <TabsContent value="withdraw" className="space-y-4 pt-4">
              <TransferForm
                choices={tokenChoices}
                choiceKey={choiceKey}
                setChoiceKey={setChoiceKey}
                amount={amountInput}
                setAmount={setAmountInput}
                pending={pending}
                actionLabel="Withdraw"
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
  choiceKey: string;
  setChoiceKey: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  pending: boolean;
  actionLabel: string;
  onSubmit: () => void;
}

function TransferForm({
  choices,
  choiceKey,
  setChoiceKey,
  amount,
  setAmount,
  pending,
  actionLabel,
  onSubmit,
}: TransferFormProps) {
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
                No EVM chains configured yet.
              </div>
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="transfer-amount" className="text-sm font-medium">
          Amount
        </Label>
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
