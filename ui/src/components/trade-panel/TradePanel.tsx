"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useExchangeStore } from "@/lib/store";
import { sideLegs } from "@/lib/wallet";
import { useWalletConnect } from "@/lib/hooks/useWalletConnect";
import { Card, CardContent } from "@/components/ui/card";
import { OrderTypeSelector } from "./OrderTypeSelector";
import { SideSelector } from "./SideSelector";
import { PriceInput } from "./PriceInput";
import { PostOnlyToggle } from "./PostOnlyToggle";
import { HiddenToggle } from "./HiddenToggle";
import { FillOrderIdInput } from "./FillOrderIdInput";
import { SizeInput } from "./SizeInput";
import { OrderSummary } from "./OrderSummary";
import { SettlementSection } from "./SettlementSection";
import { SubmitButton } from "./SubmitButton";
import { TransferDialog } from "@/components/TransferDialog";
import { AvailableBalance } from "./AvailableBalance";
import { MessageDisplay } from "./MessageDisplay";
import {
  useMarketData,
  useOrderEstimate,
  useTradeFormSubmit,
  usePriceSelection,
} from "./hooks";
import type { TradeFormData } from "./types";

export function TradePanel() {
  const selectedMarketId = useExchangeStore((state) => state.selectedMarketId);
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  const connectedWallets = useExchangeStore((state) => state.connectedWallets);
  const { connectEvm, connectSolana } = useWalletConnect();
  const [faucetOpen, setFaucetOpen] = useState(false);
  const lastMarketIdRef = useRef<string | null>(null);

  // React Hook Form
  const {
    watch,
    setValue,
    handleSubmit: rhfHandleSubmit,
  } = useForm<TradeFormData>({
    defaultValues: {
      side: "buy",
      orderType: "limit",
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

  // watch() returns a fresh closure per render — React Compiler flags
  // it as "incompatible library" because it can't safely memoise the
  // result. The whole point here is exactly that: we want formData to
  // re-read every render so the computed summary / balance checks stay
  // in sync. Suppress the warning for this one call.
  // eslint-disable-next-line react-hooks/incompatible-library
  const formData = watch();

  // Custom hooks for data and logic
  const {
    selectedMarket,
    baseToken,
    quoteToken,
    availableBase,
    availableQuote,
    lastTradePrice,
    bestBid,
    bestAsk,
    priceDecimals,
  } = useMarketData();

  const estimate = useOrderEstimate({
    price: formData.price,
    size: formData.size,
    side: formData.side,
    orderType: formData.orderType,
    bestBid,
    bestAsk,
    lastTradePrice,
    makerFeeBps: selectedMarket?.maker_fee_bps ?? 0,
    takerFeeBps: selectedMarket?.taker_fee_bps ?? 0,
  });

  const { submitOrder, loading, success, error } = useTradeFormSubmit({
    selectedMarket,
    baseToken,
    quoteToken,
    availableBase,
    availableQuote,
    bestAsk,
    lastTradePrice,
    onSuccess: () => {
      setValue("price", "");
      setValue("size", "");
      // The redirect acknowledgement is PER ORDER — every redirected
      // order re-asks. The address and toggle stay, for a user placing
      // several orders to the same destination on purpose.
      setValue("settleRedirectAck", false);
    },
  });

  // Handle price selection from orderbook
  usePriceSelection({
    orderType: formData.orderType,
    priceDecimals,
    selectedMarket,
    baseToken,
    quoteToken,
    setValue,
  });

  // A settlement address names a chain; a different market may put a
  // different chain (even a different architecture) on the receiving leg.
  // Clear the whole settlement subform on a market switch rather than
  // letting an address entered for one market ride into another.
  useEffect(() => {
    if (
      lastMarketIdRef.current !== null &&
      lastMarketIdRef.current !== selectedMarketId
    ) {
      setValue("settleToDifferent", false);
      setValue("settleAddress", "");
      setValue("settleRedirectAck", false);
      setValue("sameAddressAck", false);
    }
    lastMarketIdRef.current = selectedMarketId;
  }, [selectedMarketId, setValue]);

  // Calculate current price for size calculations
  const currentPrice =
    formData.orderType === "limit"
      ? parseFloat(formData.price) || null
      : (formData.side === "buy" ? bestAsk : bestBid) || lastTradePrice;

  // If placing this order needs a wallet ecosystem the user hasn't
  // connected, surface a connect-wallet CTA in place of the submit button.
  // Side-aware: the SIGNING wallet is the giving leg's (buy → quote,
  // sell → base), which is what makes cross-ecosystem markets tradeable —
  // the receiving leg needs only an address (see SettlementSection).
  // Hooks must run unconditionally — compute before any early returns.
  const requiredEcosystem = useMemo(
    () =>
      selectedMarket
        ? sideLegs(selectedMarket, formData.side).signingEcosystem
        : null,
    [selectedMarket, formData.side],
  );
  const hasMatchingWallet = useMemo(
    () =>
      Object.values(connectedWallets).some(
        (w) => w.ecosystem === requiredEcosystem,
      ),
    [connectedWallets, requiredEcosystem],
  );
  const missingEcosystem =
    requiredEcosystem && !hasMatchingWallet ? requiredEcosystem : null;
  const handleConnectMissing = () => {
    if (missingEcosystem === "solana") connectSolana();
    else if (missingEcosystem === "evm") connectEvm();
  };

  // Form submission handler
  const onSubmit = (data: TradeFormData) => {
    submitOrder(data);
  };

  // Early returns for loading states
  if (!selectedMarketId || !selectedMarket) {
    return (
      <Card className="h-full min-h-[400px]">
        <CardContent className="flex items-center justify-center h-full">
          <p className="text-muted-foreground text-sm">
            Select a market to trade
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!baseToken || !quoteToken) {
    return (
      <Card className="h-full min-h-[400px]">
        <CardContent className="flex items-center justify-center h-full">
          <p className="text-muted-foreground text-sm">
            Loading token information...
          </p>
        </CardContent>
      </Card>
    );
  }

  // Calculate fee bps based on order type
  const feeBps =
    formData.orderType === "market"
      ? selectedMarket.taker_fee_bps
      : selectedMarket.maker_fee_bps;

  return (
    <Card className="h-full flex flex-col gap-0 py-0 overflow-hidden border-border/40 bg-card min-w-0">
      <OrderTypeSelector
        value={formData.orderType}
        onChange={(value) => {
          setValue("orderType", value);
          // Post-only and discretionary fill-by-order-id are both
          // limit-only; clear them on a switch to market so the
          // previous state can't ride along silently.
          if (value === "market") {
            setValue("postOnly", false);
            setValue("matchingOrderIds", []);
          }
        }}
      />

      <form
        onSubmit={rhfHandleSubmit(onSubmit)}
        className="flex-1 flex flex-col min-h-0"
      >
        <CardContent className="p-3 space-y-3 flex-1 overflow-y-auto">
          {/* Buy/Sell Buttons */}
          <SideSelector
            value={formData.side}
            onChange={(value) => {
              setValue("side", value);
              // Flipping the side swaps which leg receives — a settlement
              // address entered for one chain may now name the other, and
              // an acknowledgement given for one destination must not
              // carry over. Validation would catch a wrong-architecture
              // address anyway; the ack reset is the part that matters.
              setValue("settleRedirectAck", false);
            }}
          />

          {/* Available Balance */}
          <AvailableBalance
            side={formData.side}
            availableBase={availableBase}
            availableQuote={availableQuote}
            baseToken={baseToken}
            quoteToken={quoteToken}
            isAuthenticated={isAuthenticated}
            onFaucetClick={() => setFaucetOpen(true)}
          />

          {/* Price - Only for limit orders */}
          {formData.orderType === "limit" && (
            <>
              <PriceInput
                value={formData.price}
                onChange={(value) => setValue("price", value)}
                market={selectedMarket}
                quoteToken={quoteToken}
              />
              <PostOnlyToggle
                value={formData.postOnly}
                onChange={(value) => setValue("postOnly", value)}
              />
              <FillOrderIdInput
                value={formData.matchingOrderIds?.[0] ?? ""}
                onChange={(value) =>
                  setValue("matchingOrderIds", value ? [value] : [])
                }
              />
            </>
          )}

          {/* Hidden — valid for both limit and market, so not inside the
              limit-only block above */}
          <HiddenToggle
            value={formData.hidden}
            onChange={(value) => setValue("hidden", value)}
          />

          {/* Size */}
          <SizeInput
            value={formData.size}
            onChange={(value) => setValue("size", value)}
            market={selectedMarket}
            baseToken={baseToken}
            quoteToken={quoteToken}
            side={formData.side}
            availableBase={availableBase}
            availableQuote={availableQuote}
            currentPrice={currentPrice}
            isAuthenticated={isAuthenticated}
          />

          {/* Settlement — where each leg of this order settles, and the
              settle-to-a-different-address controls. */}
          <SettlementSection
            market={selectedMarket}
            side={formData.side}
            settleToDifferent={formData.settleToDifferent}
            settleAddress={formData.settleAddress}
            settleRedirectAck={formData.settleRedirectAck}
            sameAddressAck={formData.sameAddressAck}
            setValue={setValue}
          />

          {/* Error/Success Messages */}
          <MessageDisplay error={error} success={success} />
        </CardContent>

        {/* Bottom section with summary and button */}
        <div className="p-3 space-y-3 mt-auto">
          {/* Estimated total and fees */}
          <OrderSummary
            estimate={estimate}
            side={formData.side}
            quoteToken={quoteToken}
            priceDecimals={priceDecimals}
            feeBps={feeBps}
          />

          {/* Submit Button */}
          <SubmitButton
            side={formData.side}
            baseToken={baseToken}
            isAuthenticated={isAuthenticated}
            loading={loading}
            missingEcosystem={missingEcosystem}
            onConnectMissing={handleConnectMissing}
          />
        </div>
      </form>

      {/* Transfer Dialog - opened by clicking the available balance. */}
      <TransferDialog
        controlled
        open={faucetOpen}
        onOpenChange={setFaucetOpen}
      />
    </Card>
  );
}
