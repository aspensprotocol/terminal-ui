import { useState, useCallback } from "react";
import { useExchangeStore } from "@/lib/store";
import { useExchangeClient } from "@/lib/hooks/useExchangeClient";
import {
  buildOrderCommitment,
  clientNonce,
  decimalToRaw,
  FCE_ORDER_NONCE,
  marketBidQuoteBudget,
  signOrder,
  type OrderSigningData,
} from "@aspens/terminal-sdk";
import { createActiveSigningAdapter } from "@/lib/signing-adapter";
import { useFceEnabled } from "@/lib/providers/fce-context";
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
  const fceEnabled = useFceEnabled();
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
        const pairDecimals = selectedMarket.pairDecimals ?? 8;

        // The order's amounts, converted from what the user typed to the raw
        // pair-decimal integers the wire carries — ONCE, here, and then
        // threaded unchanged into the message the wallet signs, the message
        // the SDK transmits and the local id derivation. The arborter verifies
        // the signature against its own re-encoding of the `Order` it
        // receives, so a second conversion anywhere downstream is a second
        // chance to produce a different number; the order is then refused for
        // a bad signature, which says nothing about an amount having moved.
        //
        // `decimalToRaw` is string/BigInt arithmetic on purpose. The float
        // route this replaced (`Math.round(x * 10 ** pairDecimals)`) cannot
        // represent 10**18, so on an 18-decimal market a price of 1.1 became
        // 1100000000000000128.
        //
        // A market order has no price: leave it undefined so the signed
        // message and the wire message agree by carrying nothing, rather than
        // by both happening to encode zero.
        const priceRaw =
          data.orderType === "limit"
            ? decimalToRaw(data.price, pairDecimals)
            : undefined;
        const sizeRaw = decimalToRaw(data.size, pairDecimals);

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
            // Same string-based conversion as the amounts above: this figure
            // is not signature-critical on its own, but the budget it sizes
            // IS signed, so it has no business being derived by arithmetic the
            // rest of the path has abandoned.
            referencePriceRaw: decimalToRaw(
              referencePrice.toString(),
              pairDecimals,
            ),
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

        // The order's nonce, minted ONCE here and threaded through every place
        // that must agree on it: the message the wallet signs, the message the
        // wire carries, and the local id derivation. The arborter derives the
        // canonical order id from the signed `Order`, so a nonce that differs
        // between any two of those three yields either a bad signature or an id
        // nobody else derives — and neither says so.
        //
        // The FCE transport can only express zero: its direct-action JSON has
        // no nonce field, so the adapter rebuilds the order without one. Zero
        // is wire-skipped, which is exactly what that rebuild produces.
        const nonce = fceEnabled ? FCE_ORDER_NONCE : clientNonce();

        // Create order signing data. `quoteBudget` rides INSIDE the Order, so
        // the envelope signature below covers it.
        const orderData: OrderSigningData = {
          side: data.side,
          quantity: sizeRaw,
          price: priceRaw,
          marketId: selectedMarket.id,
          baseAccountAddress: signerAddress,
          quoteAccountAddress: signerAddress,
          postOnly: effectivePostOnly,
          hidden: data.hidden,
          quoteBudget,
          nonce,
        };

        // Sign the order envelope using the matched wallet. This
        // (EIP-191 / personal_sign over the protobuf Order bytes)
        // remains the auth over the SendOrderRequest itself.
        const signingAdapter = createActiveSigningAdapter();
        const signature = await signOrder(orderData, signingAdapter);

        // The caller's own copy of the canonical order id. It is NOT sent over
        // gRPC — `OrderAuthorization` is gone and the arborter derives the id
        // from the signed order — so it is only computed on the FCE transport,
        // whose direct-action JSON still declares an `orderId` key. Deriving it
        // needs the arborter config (chain ids) and would throw without one;
        // there is no reason to make a gRPC order fail on a lookup its result
        // never reaches.
        let orderId: string | undefined;
        if (fceEnabled) {
          const config = client.cache.getConfig();
          if (!config) {
            throw new Error(
              "Arborter configuration not loaded yet — retry in a moment",
            );
          }
          orderId = buildOrderCommitment({
            market: selectedMarket,
            config,
            side: data.side,
            // The address the signature verified against — a bid signs with
            // the quote account, an ask with the base account, and this UI
            // uses one wallet for both.
            userAddress: signerAddress,
            quantityRaw: sizeRaw,
            priceRaw,
            quoteBudgetRaw: quoteBudget,
            // The same nonce the wallet signed above.
            nonce,
          }).orderId;
        }

        // Place the order via SDK
        const result = await client.placeOrder({
          userAddress: signerAddress,
          marketId: selectedMarket.id,
          side: data.side,
          orderType: data.orderType,
          // The raw values derived above — the very ones inside `orderData`,
          // not a decimal string for the SDK to convert a second time. The SDK
          // puts these on the wire untouched, so the bytes the arborter
          // verifies are the bytes the wallet signed.
          priceRaw,
          sizeRaw,
          pairDecimals,
          signature,
          baseAccountAddress: signerAddress,
          quoteAccountAddress: signerAddress,
          orderId,
          postOnly: effectivePostOnly,
          hidden: data.hidden,
          // Must be the SAME values that went into `orderData` above, or the
          // wire order won't match the bytes the wallet signed.
          quoteBudget,
          nonce,
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
      fceEnabled,
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
