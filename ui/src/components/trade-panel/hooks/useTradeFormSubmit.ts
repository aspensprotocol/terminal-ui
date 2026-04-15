import { useState, useCallback } from "react";
import { useExchangeStore } from "@/lib/store";
import { useExchangeClient } from "@/lib/hooks/useExchangeClient";
import {
  buildEvmGaslessAuthorization,
  buildSolanaGaslessAuthorization,
  signOrder,
  type GaslessAuthorization,
  type OrderSigningData,
} from "@exchange/sdk";
import { createActiveSigningAdapter } from "@/lib/signing-adapter";
import { marketEcosystem } from "@/lib/wallet";
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
  const setActiveWallet = useExchangeStore((state) => state.setActiveWallet);

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
      if (
        data.orderType === "limit" &&
        (!data.price.trim() || parseFloat(data.price) <= 0)
      ) {
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
        const priceNum =
          data.orderType === "limit"
            ? parseFloat(data.price)
            : bestAsk || lastTradePrice || 0;
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

      // Resolve which wallet ecosystem this market needs to sign with.
      const requiredEcosystem = marketEcosystem(selectedMarket);
      if (!requiredEcosystem) {
        setError(
          "This market's chains aren't supported by any connected wallet yet",
        );
        return;
      }

      // Pick the signing wallet: prefer the active one if it matches,
      // otherwise switch to a connected wallet of the required ecosystem.
      const { connectedWallets, activeWalletId } = useExchangeStore.getState();
      const activeWallet = activeWalletId
        ? connectedWallets[activeWalletId]
        : null;
      let signingWallet =
        activeWallet?.ecosystem === requiredEcosystem ? activeWallet : null;
      if (!signingWallet) {
        const match = Object.values(connectedWallets).find(
          (w) => w.ecosystem === requiredEcosystem,
        );
        if (match) {
          setActiveWallet(match.id);
          signingWallet = match;
        }
      }
      if (!signingWallet) {
        setError(
          requiredEcosystem === "solana"
            ? "Connect a Solana wallet to trade this market"
            : "Connect an EVM wallet to trade this market",
        );
        return;
      }

      setLoading(true);

      try {
        const finalPrice =
          data.orderType === "limit" ? parseFloat(data.price) : 0;
        const finalSize = parseFloat(data.size);
        const pairDecimals = selectedMarket.pairDecimals ?? 8;

        // Convert to raw integer strings for protobuf
        const priceRaw = BigInt(
          Math.round(finalPrice * Math.pow(10, pairDecimals)),
        ).toString();
        const sizeRaw = BigInt(
          Math.round(finalSize * Math.pow(10, pairDecimals)),
        ).toString();

        const signerAddress = signingWallet.address;

        // Create order signing data
        const orderData: OrderSigningData = {
          side: data.side,
          quantity: sizeRaw,
          price: data.orderType === "limit" ? priceRaw : undefined,
          marketId: selectedMarket.id,
          baseAccountAddress: signerAddress,
          quoteAccountAddress: signerAddress,
        };

        // Sign the order envelope using the matched wallet. This
        // (EIP-191 / personal_sign over the protobuf Order bytes)
        // remains the auth over the SendOrderRequest itself.
        const signingAdapter = createActiveSigningAdapter();
        const signature = await signOrder(orderData, signingAdapter);

        // Build the gasless authorization for every chain architecture.
        // Arborter's legacy arborter-signed path was deprecated on EVM
        // (it still serves Hedera / legacy-only chains). For EVM +
        // Solana a `GaslessAuthorization` is required.
        const config = client.cache.getConfig();
        if (!config) {
          throw new Error(
            "Arborter configuration not loaded yet — retry in a moment",
          );
        }
        const amountIn = BigInt(
          data.side === "buy"
            ? Math.round(
                finalSize *
                  (data.orderType === "limit" ? finalPrice : 0) *
                  Math.pow(10, pairDecimals),
              )
            : Math.round(finalSize * Math.pow(10, pairDecimals)),
        );
        const amountOut = BigInt(
          data.side === "buy"
            ? Math.round(finalSize * Math.pow(10, pairDecimals))
            : Math.round(
                finalSize *
                  (data.orderType === "limit" ? finalPrice : 0) *
                  Math.pow(10, pairDecimals),
              ),
        );
        let gasless: GaslessAuthorization | undefined;
        if (requiredEcosystem === "evm") {
          const { authorization } = await buildEvmGaslessAuthorization({
            market: selectedMarket,
            config,
            side: data.side,
            amountIn,
            amountOut,
            userAddress: signerAddress as `0x${string}`,
            adapter: signingAdapter,
          });
          gasless = authorization;
        } else if (requiredEcosystem === "solana") {
          const { authorization } = await buildSolanaGaslessAuthorization({
            market: selectedMarket,
            config,
            side: data.side,
            amountIn,
            amountOut,
            userAddress: signerAddress,
            adapter: signingAdapter,
          });
          gasless = authorization;
        }

        // Place the order via SDK
        const result = await client.placeOrder({
          userAddress: signerAddress,
          marketId: selectedMarket.id,
          side: data.side,
          orderType: data.orderType,
          priceDecimal: finalPrice.toString(),
          sizeDecimal: finalSize.toString(),
          signature,
          baseAccountAddress: signerAddress,
          quoteAccountAddress: signerAddress,
          gasless,
        });

        const successMessage = `Order placed! ${
          result.trades && result.trades.length > 0
            ? `Filled ${result.trades.length} trade(s)`
            : "Order in book"
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
          if (
            err.message.includes("rejected") ||
            err.message.includes("denied")
          ) {
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
      setActiveWallet,
      client,
      onSuccess,
    ],
  );

  return {
    submitOrder,
    loading,
    success,
    error,
  };
}
