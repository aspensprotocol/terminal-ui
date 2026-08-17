import { useState, useCallback } from "react";
import { useExchangeStore } from "@/lib/store";
import { useExchangeClient } from "@/lib/hooks/useExchangeClient";
import {
  buildEvmGaslessAuthorization,
  buildSolanaGaslessAuthorization,
  marketBidQuoteBudget,
  signOrder,
  type OrderAuthorization,
  type OrderSigningData,
} from "@aspens/terminal-sdk";
import { createActiveSigningAdapter } from "@/lib/signing-adapter";
import { marketEcosystem } from "@/lib/wallet";
import type { Market, Token } from "@/lib/types/exchange";
import type { TradeFormData } from "../types";

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

        // Post-only is limit-only. The UI already hides the toggle for
        // market orders, but defend against a stale `postOnly: true`
        // hanging on the form (e.g. a fast switch between order types)
        // by forcing it to false here. Both the signing data and the
        // SDK call read this same value, keeping the signed digest and
        // the wire request in lock-step.
        const effectivePostOnly =
          data.orderType === "limit" ? data.postOnly : false;

        // Every order commits a budget denominated in the asset it gives, and
        // three of the four cells derive theirs: an ask gives `quantity` of
        // base; a limit bid gives at most `quantity * price` of quote. The
        // arborter derives those itself and REJECTS a caller-supplied budget
        // on them, so `quoteBudget` stays undefined outside the market bid.
        //
        // A MARKET BID is the exception: it gives quote with no price to
        // convert its quantity with, so nothing derivable bounds it and the
        // arborter refuses one that doesn't state a budget. Size it at the
        // same reference price the balance check above used, and in the QUOTE
        // token's own decimals — the wire field is in native base units, not
        // pair decimals, and a figure at the wrong scale is mis-collateralised
        // rather than rejected.
        //
        // This makes the budget exactly the estimated total already shown to
        // the user, which is also its limitation: an upward move between
        // signing and matching buys less than `size` rather than overspending.
        // A real market-buy UI would take the spend amount as the input.
        let quoteBudget: string | undefined;
        if (data.side === "buy" && data.orderType === "market") {
          const referencePrice = bestAsk || lastTradePrice || 0;
          if (referencePrice <= 0) {
            setError(
              "No reference price yet for this market — a market buy needs one to size its budget. Use a limit order.",
            );
            return;
          }
          // Prefer the market's own view of the quote token's decimals; the
          // per-chain figure and the token record must agree, and the market
          // is the one the arborter converts with.
          const quoteTokenDecimals =
            selectedMarket.quoteChainTokenDecimals ?? quoteToken.decimals;
          const budget = marketBidQuoteBudget({
            sizeRaw,
            referencePriceRaw: BigInt(
              Math.round(referencePrice * Math.pow(10, pairDecimals)),
            ).toString(),
            pairDecimals,
            quoteTokenDecimals,
          });
          if (budget <= 0n) {
            setError(
              `Order is too small to spend any ${quoteToken.ticker} at the current price`,
            );
            return;
          }
          quoteBudget = budget.toString();
        }

        // Create order signing data. `quoteBudget` rides INSIDE the Order, so
        // the envelope signature below covers it.
        const orderData: OrderSigningData = {
          side: data.side,
          quantity: sizeRaw,
          price: data.orderType === "limit" ? priceRaw : undefined,
          marketId: selectedMarket.id,
          baseAccountAddress: signerAddress,
          quoteAccountAddress: signerAddress,
          postOnly: effectivePostOnly,
          hidden: data.hidden,
          quoteBudget,
        };

        // Sign the order envelope using the matched wallet. This
        // (EIP-191 / personal_sign over the protobuf Order bytes)
        // remains the auth over the SendOrderRequest itself.
        const signingAdapter = createActiveSigningAdapter();
        const signature = await signOrder(orderData, signingAdapter);

        // Build the order authorization. Under the optimistic ledger the
        // arborter authenticates the order via the outer envelope signature
        // and reads only order_id from this payload (no on-chain lock
        // signature): `OrderAuthorization.amount_in` was deleted, because it
        // sat outside the signed Order and so declared a commitment nothing
        // had signed. The collateral now comes from the order itself.
        //
        // The amounts below therefore no longer travel anywhere — they are
        // inputs to the order-id hash, which is what keeps a wallet's ids
        // distinct.
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
        let orderAuthorization: OrderAuthorization | undefined;
        if (requiredEcosystem === "evm") {
          const { authorization } = await buildEvmGaslessAuthorization({
            market: selectedMarket,
            config,
            side: data.side,
            amountIn,
            amountOut,
            userAddress: signerAddress as `0x${string}`,
          });
          orderAuthorization = authorization;
        } else if (requiredEcosystem === "solana") {
          const { authorization } = await buildSolanaGaslessAuthorization({
            market: selectedMarket,
            config,
            side: data.side,
            amountIn,
            amountOut,
            userAddress: signerAddress,
          });
          orderAuthorization = authorization;
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
          authorization: orderAuthorization,
          postOnly: effectivePostOnly,
          hidden: data.hidden,
          // Must be the SAME value that went into `orderData` above, or the
          // wire order won't match the bytes the wallet signed.
          quoteBudget,
        });

        // A hidden order that rested exists in NO server stream — this
        // response is the only record of it. Track it locally so the
        // open-orders panel can show and cancel it (status: "pending"
        // here means arborter reported order_in_book).
        if (data.hidden && result.status === "pending") {
          useExchangeStore.getState().recordHiddenOrder({
            ...result,
            trades: [],
          });
        }

        const successMessage = data.hidden
          ? `Hidden order placed (id ${result.id}) — tracked locally only`
          : `Order placed! ${
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
          const msg = err.message;
          // Match arborter's two post-only rejection messages BEFORE the
          // generic "rejected" branch — they contain the literal word
          // "reject" but mean something specific the user can act on
          // (adjust price or untoggle post-only), not the usual wallet
          // user-cancel UX. Arborter strings come from
          // handlers/send_order.rs and start with "post_only".
          if (msg.includes("post_only") || msg.includes("post-only")) {
            errorMessage =
              "Post-only order would cross — adjust your price (or untoggle Post-only) and resubmit";
          } else if (msg.includes("rejected") || msg.includes("denied")) {
            errorMessage = "Transaction rejected by wallet";
          } else if (msg.includes("unavailable")) {
            errorMessage = "Trading service temporarily unavailable";
          } else {
            errorMessage = msg;
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
