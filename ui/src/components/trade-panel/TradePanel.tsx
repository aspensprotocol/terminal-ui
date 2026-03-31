"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useExchangeStore } from "@/lib/store";
import { Card, CardContent } from "@/components/ui/card";
import { OrderTypeSelector } from "./OrderTypeSelector";
import { SideSelector } from "./SideSelector";
import { PriceInput } from "./PriceInput";
import { SizeInput } from "./SizeInput";
import { OrderSummary } from "./OrderSummary";
import { SubmitButton } from "./SubmitButton";
import { FaucetDialog } from "@/components/FaucetDialog";
import { AvailableBalance } from "./AvailableBalance";
import { MessageDisplay } from "./MessageDisplay";
import { useMarketData, useOrderEstimate, useTradeFormSubmit, usePriceSelection } from "./hooks";

type OrderSide = "buy" | "sell";
type OrderType = "limit" | "market";

interface TradeFormData {
  side: OrderSide;
  orderType: OrderType;
  price: string;
  size: string;
}

export function TradePanel() {
  const selectedMarketId = useExchangeStore((state) => state.selectedMarketId);
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  const [faucetOpen, setFaucetOpen] = useState(false);

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
    },
  });

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

  // Calculate current price for size calculations
  const currentPrice =
    formData.orderType === "limit"
      ? parseFloat(formData.price) || null
      : (formData.side === "buy" ? bestAsk : bestBid) || lastTradePrice;

  // Form submission handler
  const onSubmit = (data: TradeFormData) => {
    submitOrder(data);
  };

  // Early returns for loading states
  if (!selectedMarketId || !selectedMarket) {
    return (
      <Card className="h-full min-h-[400px]">
        <CardContent className="flex items-center justify-center h-full">
          <p className="text-muted-foreground text-sm">Select a market to trade</p>
        </CardContent>
      </Card>
    );
  }

  if (!baseToken || !quoteToken) {
    return (
      <Card className="h-full min-h-[400px]">
        <CardContent className="flex items-center justify-center h-full">
          <p className="text-muted-foreground text-sm">Loading token information...</p>
        </CardContent>
      </Card>
    );
  }

  // Calculate fee bps based on order type
  const feeBps = formData.orderType === "market" ? selectedMarket.taker_fee_bps : selectedMarket.maker_fee_bps;

  return (
    <Card className="h-full flex flex-col gap-0 py-0 overflow-hidden border-border/40 bg-card min-w-0">
      <OrderTypeSelector value={formData.orderType} onChange={(value) => setValue("orderType", value)} />

      <form onSubmit={rhfHandleSubmit(onSubmit)} className="flex-1 flex flex-col min-h-0">
        <CardContent className="p-3 space-y-3 flex-1 overflow-y-auto">
          {/* Buy/Sell Buttons */}
          <SideSelector value={formData.side} onChange={(value) => setValue("side", value)} />

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
            <PriceInput
              value={formData.price}
              onChange={(value) => setValue("price", value)}
              market={selectedMarket}
              quoteToken={quoteToken}
            />
          )}

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
          />
        </div>
      </form>

      {/* Faucet Dialog - controlled by available balance click */}
      <FaucetDialog controlled open={faucetOpen} onOpenChange={setFaucetOpen} />
    </Card>
  );
}
