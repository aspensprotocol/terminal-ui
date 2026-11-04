"use client";

/**
 * Swap: pay one asset on one chain, receive another on another chain.
 *
 * A swap is a MARKET order on the market that pairs the two assets (see
 * `lib/swap.ts`). Everything order-shaped — signing, budgets, settlement
 * addresses and their acknowledgements — goes through the same
 * `useTradeFormSubmit` and `SettlementSection` the trade panel uses, so the
 * swap page adds no second path to the venue.
 */

import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { ArrowDown } from "lucide-react";
import { formatNumber } from "@aspensprotocol/sdk-ts";
import {
  useExchangeStore,
  selectOrderbookBids,
  selectOrderbookAsks,
} from "@/lib/store";
import { useMarkets, useOrderbook, useTrades } from "@/lib/hooks";
import { useWalletConnect } from "@/lib/hooks/useWalletConnect";
import { sideLegs } from "@/lib/wallet";
import {
  findRoute,
  quoteSwap,
  receivableAssets,
  swapAssets,
  swapOrderSize,
  type SwapAsset,
} from "@/lib/swap";
import { chainName } from "@/lib/assetLogos";
import { Button } from "@/components/ui/button";
import { TransferDialog } from "@/components/TransferDialog";
import { SettlementSection } from "@/components/trade-panel/SettlementSection";
import { MessageDisplay } from "@/components/trade-panel/MessageDisplay";
import { connectLabel } from "@/components/trade-panel/SubmitButton";
import {
  useMarketData,
  useTradeFormSubmit,
} from "@/components/trade-panel/hooks";
import type { TradeFormData } from "@/components/trade-panel/types";
import { AssetPicker } from "./AssetPicker";

/** Price impact above this gets a warning colour. */
const IMPACT_WARN_PCT = 1;

export function SwapPanel() {
  const { markets, isLoading, error: marketsError } = useMarkets();
  const selectedMarketId = useExchangeStore((s) => s.selectedMarketId);
  const selectMarket = useExchangeStore((s) => s.selectMarket);
  const isAuthenticated = useExchangeStore((s) => s.isAuthenticated);
  const connectedWallets = useExchangeStore((s) => s.connectedWallets);
  const bids = useExchangeStore(selectOrderbookBids);
  const asks = useExchangeStore(selectOrderbookAsks);
  const { openPicker } = useWalletConnect();

  const [payKey, setPayKey] = useState("");
  const [receiveKey, setReceiveKey] = useState("");
  const [amount, setAmount] = useState("");
  const [depositOpen, setDepositOpen] = useState(false);

  const assets = useMemo(() => swapAssets(markets), [markets]);
  const receivable = useMemo(
    () => (payKey ? receivableAssets(markets, payKey) : []),
    [markets, payKey],
  );
  const route = useMemo(
    () => findRoute(markets, payKey, receiveKey),
    [markets, payKey, receiveKey],
  );

  // Default pair: the currently selected market (or the first), paying quote
  // for base — the common "spend stablecoin" direction.
  useEffect(() => {
    if (payKey || markets.length === 0) return;
    const m = markets.find((x) => x.id === selectedMarketId) ?? markets[0]!;
    setPayKey(`${m.quote_ticker}@${m.quoteChainNetwork ?? ""}`);
    setReceiveKey(`${m.base_ticker}@${m.baseChainNetwork ?? ""}`);
  }, [markets, payKey, selectedMarketId]);

  // A new pay asset may not pair with the old receive asset.
  useEffect(() => {
    if (!payKey || receivable.length === 0) return;
    if (!receivable.some((a) => a.key === receiveKey)) {
      setReceiveKey(receivable[0]!.key);
    }
  }, [payKey, receivable, receiveKey]);

  // The route's market drives the store, so the book, balances and the
  // shared submit path all read the right market.
  const routeMarketId = route?.market.id ?? null;
  useEffect(() => {
    if (routeMarketId && routeMarketId !== selectedMarketId) {
      selectMarket(routeMarketId);
    }
  }, [routeMarketId, selectedMarketId, selectMarket]);
  const marketReady =
    routeMarketId !== null && routeMarketId === selectedMarketId;
  useOrderbook(marketReady ? routeMarketId : null);
  useTrades(marketReady ? routeMarketId : null);

  const {
    selectedMarket,
    baseToken,
    quoteToken,
    availableBase,
    availableQuote,
    lastTradePrice,
    bestAsk,
  } = useMarketData();

  const side = route?.side ?? "buy";
  const payAsset = assets.find((a) => a.key === payKey);
  const receiveAsset = assets.find((a) => a.key === receiveKey);
  const payBalance = side === "sell" ? availableBase : availableQuote;
  const payNum = parseFloat(amount) || 0;

  const quote = useMemo(
    () =>
      marketReady && route
        ? quoteSwap(
            side,
            payNum,
            side === "sell" ? bids : asks,
            route.market.taker_fee_bps,
          )
        : null,
    [marketReady, route, side, payNum, bids, asks],
  );

  // Settlement fields only — side, size and type are the swap's own.
  const { watch, setValue, reset } = useForm<TradeFormData>({
    defaultValues: {
      side: "buy",
      orderType: "market",
      price: "",
      size: "",
      postOnly: false,
      hidden: false,
      matchingOrderIds: [],
      settleToDifferent: false,
      settleAddress: "",
      settleRedirectAck: false,
      sameAddressAck: false,
    },
  });
  // eslint-disable-next-line react-hooks/incompatible-library
  const form = watch();

  // An address entered for one route's receiving chain must not ride into
  // another route — same rule the trade panel applies on a market switch.
  useEffect(() => {
    reset();
  }, [routeMarketId, side, reset]);

  const { submitOrder, loading, success, error } = useTradeFormSubmit({
    selectedMarket,
    baseToken,
    quoteToken,
    availableBase,
    availableQuote,
    bestAsk,
    lastTradePrice,
    onSuccess: () => {
      setAmount("");
      setValue("settleRedirectAck", false);
    },
  });

  const requiredEcosystem = selectedMarket
    ? sideLegs(selectedMarket, side).signingEcosystem
    : null;
  const missingEcosystem =
    requiredEcosystem &&
    !Object.values(connectedWallets).some(
      (w) => w.ecosystem === requiredEcosystem,
    )
      ? requiredEcosystem
      : null;

  const pairDecimals = selectedMarket?.pairDecimals ?? 8;
  const size =
    route && marketReady
      ? swapOrderSize(side, payNum, bestAsk, pairDecimals)
      : null;

  const onSwap = () => {
    if (!route || !size) return;
    submitOrder({
      ...form,
      side,
      orderType: "market",
      price: "",
      size,
      postOnly: false,
      hidden: false,
      matchingOrderIds: [],
    });
  };

  const flip = () => {
    setPayKey(receiveKey);
    setReceiveKey(payKey);
    setAmount("");
  };

  // One button, one state — the first thing standing between the user and a swap.
  const action = ((): {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
  } => {
    if (!isAuthenticated)
      return { label: "Connect wallet", onClick: () => openPicker() };
    if (missingEcosystem)
      return {
        label: connectLabel(missingEcosystem),
        onClick: () => openPicker(missingEcosystem),
      };
    if (!route) return { label: "No route for this pair", disabled: true };
    if (loading) return { label: "Swapping…", disabled: true };
    if (!(payNum > 0)) return { label: "Enter an amount", disabled: true };
    if (payNum > payBalance)
      return {
        label: `Deposit ${payAsset?.ticker ?? ""}`,
        onClick: () => setDepositOpen(true),
      };
    if (!quote) return { label: "No liquidity", disabled: true };
    if (quote.insufficientLiquidity)
      return { label: "Not enough liquidity", disabled: true };
    if (!size) return { label: "Amount too small", disabled: true };
    return { label: "Swap", onClick: onSwap };
  })();

  if (isLoading) {
    return (
      <Shell>
        <p className="py-16 text-center text-sm text-muted-foreground">
          Loading markets…
        </p>
      </Shell>
    );
  }
  if (assets.length === 0) {
    return (
      <Shell>
        <p className="py-16 text-center text-sm text-muted-foreground">
          {marketsError ? "Markets unavailable" : "No markets"}
        </p>
      </Shell>
    );
  }

  const impactWarn = (quote?.priceImpactPct ?? 0) > IMPACT_WARN_PCT;

  return (
    <Shell>
      {/* Pay */}
      <Leg label="You pay">
        <div className="flex items-center gap-3">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={amount}
            onChange={(e) => {
              const v = e.target.value.replace(",", ".");
              if (/^\d*\.?\d*$/.test(v)) setAmount(v);
            }}
            className="min-w-0 flex-1 bg-transparent font-mono text-3xl outline-none placeholder:text-muted-foreground/40"
            aria-label="Amount to pay"
          />
          <AssetPicker
            label="Pay with"
            items={assets}
            value={payKey}
            onChange={setPayKey}
            align="end"
          />
        </div>
        <LegFooter asset={payAsset}>
          {isAuthenticated && route && (
            <span className="flex items-center gap-2">
              <span>Balance {formatNumber(payBalance, 6)}</span>
              {payBalance > 0 && (
                <button
                  type="button"
                  onClick={() => setAmount(String(payBalance))}
                  className="font-semibold text-primary hover:text-primary/80 cursor-pointer"
                >
                  MAX
                </button>
              )}
            </span>
          )}
        </LegFooter>
      </Leg>

      {/* Flip */}
      <div className="relative z-10 -my-3 flex justify-center">
        <button
          type="button"
          onClick={flip}
          disabled={!route}
          aria-label="Switch pay and receive"
          className="flex size-9 items-center justify-center rounded-lg border-4 border-card bg-muted text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 cursor-pointer"
        >
          <ArrowDown className="size-4" />
        </button>
      </div>

      {/* Receive */}
      <Leg label="You receive">
        <div className="flex items-center gap-3">
          <div
            className={`min-w-0 flex-1 truncate font-mono text-3xl ${
              quote ? "" : "text-muted-foreground/40"
            }`}
          >
            {quote ? formatNumber(quote.receive, 6) : "0"}
          </div>
          <AssetPicker
            label="Receive"
            items={receivable}
            value={receiveKey}
            onChange={setReceiveKey}
            align="end"
            disabled={receivable.length === 0}
          />
        </div>
        <LegFooter asset={receiveAsset} />
      </Leg>

      {/* Details */}
      {quote && payAsset && receiveAsset && (
        <dl className="mt-3 space-y-1.5 px-1 text-xs">
          <Row label="Rate">
            1 {payAsset.ticker} ≈ {formatNumber(quote.rate, 6)}{" "}
            {receiveAsset.ticker}
          </Row>
          <Row label="Price impact">
            <span className={impactWarn ? "text-amber-400" : undefined}>
              {quote.priceImpactPct < 0.01
                ? "<0.01%"
                : `${quote.priceImpactPct.toFixed(2)}%`}
            </span>
          </Row>
          <Row label={`Fee (${route?.market.taker_fee_bps ?? 0} bps)`}>
            {formatNumber(quote.fee, 6)} {receiveAsset.ticker}
          </Row>
        </dl>
      )}

      {/* Settlement — where each leg settles; collapsed by default. */}
      {selectedMarket && marketReady && (
        <div className="mt-3 [&>*]:text-xs">
          <SettlementSection
            market={selectedMarket}
            side={side}
            settleToDifferent={form.settleToDifferent}
            settleAddress={form.settleAddress}
            settleRedirectAck={form.settleRedirectAck}
            sameAddressAck={form.sameAddressAck}
            setValue={setValue}
          />
        </div>
      )}

      <div className="mt-3">
        <MessageDisplay error={error} success={success} />
      </div>

      <Button
        type="button"
        onClick={action.onClick}
        disabled={action.disabled}
        className="mt-3 h-12 w-full text-base font-semibold cursor-pointer"
      >
        {action.label}
      </Button>

      <p className="mt-3 text-center text-[10px] text-muted-foreground/60">
        Fills as a market order from your deposited balance. The received amount
        is an estimate from the live book.
      </p>

      <TransferDialog
        controlled
        open={depositOpen}
        onOpenChange={setDepositOpen}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[460px] rounded-2xl border border-border bg-card p-3 shadow-xl">
      <h1 className="px-1 pb-3 text-sm font-semibold">Swap</h1>
      {children}
    </div>
  );
}

function Leg({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/50 p-4">
      <div className="mb-2 text-xs text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function LegFooter({
  asset,
  children,
}: {
  asset?: SwapAsset;
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-2 flex min-h-4 items-center justify-between text-[11px] text-muted-foreground">
      <span>{asset ? `on ${chainName(asset.network)}` : ""}</span>
      {children}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono">{children}</dd>
    </div>
  );
}
