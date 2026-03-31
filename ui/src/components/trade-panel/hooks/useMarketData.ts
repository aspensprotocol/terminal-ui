import { useMemo } from "react";
import { useExchangeStore, selectSelectedMarket, selectOrderbookBids, selectOrderbookAsks } from "@/lib/store";
import { useUserBalances } from "@/lib/hooks";
import { getDecimalPlaces } from "@exchange/sdk";

export function useMarketData() {
  const selectedMarket = useExchangeStore(selectSelectedMarket);
  const tokens = useExchangeStore((state) => state.tokens);
  const recentTrades = useExchangeStore((state) => state.recentTrades);
  const bids = useExchangeStore(selectOrderbookBids);
  const asks = useExchangeStore(selectOrderbookAsks);
  const balances = useUserBalances();

  // Look up tokens for the selected market
  const baseToken = selectedMarket ? tokens[selectedMarket.base_ticker] : undefined;
  const quoteToken = selectedMarket ? tokens[selectedMarket.quote_ticker] : undefined;

  // Get user balances
  const baseBalance = balances.find((b) => b.token_ticker === baseToken?.ticker);
  const quoteBalance = balances.find((b) => b.token_ticker === quoteToken?.ticker);

  // Calculate available balances
  const availableBase = baseBalance ? baseBalance.amountValue - baseBalance.lockedValue : 0;
  const availableQuote = quoteBalance ? quoteBalance.amountValue - quoteBalance.lockedValue : 0;

  // Get price helpers
  const lastTradePrice = recentTrades.length > 0 && recentTrades[0] ? recentTrades[0].priceValue : null;
  const bestBid = bids.length > 0 && bids[0] ? bids[0].priceValue : null;
  const bestAsk = asks.length > 0 && asks[0] ? asks[0].priceValue : null;

  // Calculate decimal places
  const priceDecimals = useMemo(
    () => (selectedMarket && quoteToken ? getDecimalPlaces(selectedMarket.tick_size, quoteToken.decimals) : 2),
    [selectedMarket, quoteToken]
  );

  return {
    selectedMarket,
    baseToken,
    quoteToken,
    availableBase,
    availableQuote,
    lastTradePrice,
    bestBid,
    bestAsk,
    priceDecimals,
  };
}
