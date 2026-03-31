import { useState, useCallback } from "react";
import { useExchangeStore } from "@/lib/store";
import { useExchangeClient } from "@/lib/hooks/useExchangeClient";
import { signOrder, type OrderSigningData } from "@exchange/sdk";
import { createActiveSigningAdapter } from "@/lib/signing-adapter";
import type { Market, Token } from "@/lib/types/exchange";

interface TradeFormData {
  side: "buy" | "sell";
  orderType: "limit" | "market";
  price: string;
  size: string;
}

interface UseTradeFormSubmitParams {
  selectedMarket: Market | undefined;
  baseToken: Token | undefined;
  quoteToken: Token | undefined;
  availableBase: number;
  availableQuote: number;
  bestAsk: number | null;
  lastTradePrice: number | null;
  onSuccess?: () => void;
}

export function useTradeFormSubmit({
  selectedMarket,
  baseToken,
  quoteToken,
  availableBase,
  availableQuote,
  bestAsk,
  lastTradePrice,
  onSuccess,
}: UseTradeFormSubmitParams) {
  const client = useExchangeClient();
  const isAuthenticated = useExchangeStore((state) => state.isAuthenticated);
  const userAddress = useExchangeStore((state) => state.userAddress);

  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submitOrder = useCallback(
    async (data: TradeFormData) => {
      setError(null);
      setSuccess(null);

      // Check market data
      if (!selectedMarket || !baseToken || !quoteToken) {
        setError("Market data not loaded");
        return;
      }

      // Check authentication
      if (!isAuthenticated || !userAddress) {
        setError("Please connect your wallet first");
        return;
      }

      // Simple validation
      if (data.orderType === "limit" && (!data.price.trim() || parseFloat(data.price) <= 0)) {
        setError("Invalid price");
        return;
      }

      if (!data.size.trim() || parseFloat(data.size) <= 0) {
        setError("Invalid size");
        return;
      }

      // Check balance
      const sizeNum = parseFloat(data.size);
      if (data.side === "buy") {
        const priceNum = data.orderType === "limit" ? parseFloat(data.price) : bestAsk || lastTradePrice || 0;
        const requiredQuote = sizeNum * priceNum;
        if (requiredQuote > availableQuote) {
          setError(`Insufficient ${quoteToken.ticker} balance`);
          return;
        }
      } else {
        if (sizeNum > availableBase) {
          setError(`Insufficient ${baseToken.ticker} balance`);
          return;
        }
      }

      setLoading(true);

      try {
        const finalPrice = data.orderType === "limit" ? parseFloat(data.price) : 0;
        const finalSize = parseFloat(data.size);
        const pairDecimals = selectedMarket.pairDecimals ?? 8;

        // Convert to raw integer strings for protobuf
        const priceRaw = BigInt(Math.round(finalPrice * Math.pow(10, pairDecimals))).toString();
        const sizeRaw = BigInt(Math.round(finalSize * Math.pow(10, pairDecimals))).toString();

        // Create order signing data
        const orderData: OrderSigningData = {
          side: data.side,
          quantity: sizeRaw,
          price: data.orderType === "limit" ? priceRaw : undefined,
          marketId: selectedMarket.id,
          baseAccountAddress: userAddress,
          quoteAccountAddress: userAddress,
        };

        // Sign the order using active wallet
        const signingAdapter = createActiveSigningAdapter();
        const signature = await signOrder(orderData, signingAdapter);

        // Place the order via SDK
        const result = await client.placeOrder({
          userAddress,
          marketId: selectedMarket.id,
          side: data.side,
          orderType: data.orderType,
          priceDecimal: finalPrice.toString(),
          sizeDecimal: finalSize.toString(),
          signature,
          baseAccountAddress: userAddress,
          quoteAccountAddress: userAddress,
        });

        const successMessage = `Order placed! ${
          result.trades && result.trades.length > 0 ? `Filled ${result.trades.length} trade(s)` : "Order in book"
        }`;
        setSuccess(successMessage);

        // Call onSuccess callback
        onSuccess?.();

        // Auto-clear success message after 3 seconds
        setTimeout(() => setSuccess(null), 3000);
      } catch (err) {
        console.error("Order submission error:", err);
        let errorMessage = "Failed to place order";

        if (err instanceof Error) {
          if (err.message.includes("rejected") || err.message.includes("denied")) {
            errorMessage = "Transaction rejected by wallet";
          } else if (err.message.includes("unavailable")) {
            errorMessage = "Trading service temporarily unavailable";
          } else {
            errorMessage = err.message;
          }
        }

        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    },
    [
      selectedMarket,
      baseToken,
      quoteToken,
      availableBase,
      availableQuote,
      bestAsk,
      lastTradePrice,
      isAuthenticated,
      userAddress,
      client,
      onSuccess,
    ]
  );

  return {
    submitOrder,
    loading,
    success,
    error,
  };
}
