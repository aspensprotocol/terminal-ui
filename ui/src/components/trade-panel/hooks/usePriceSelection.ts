import { useEffect } from "react";
import { UseFormSetValue } from "react-hook-form";
import { useExchangeStore } from "@/lib/store";
import { roundToTickSize } from "@exchange/sdk";
import type { Market, Token } from "@/lib/types/exchange";

interface TradeFormData {
  side: "buy" | "sell";
  orderType: "limit" | "market";
  price: string;
  size: string;
}

interface UsePriceSelectionParams {
  orderType: "limit" | "market";
  priceDecimals: number;
  selectedMarket: Market | undefined;
  baseToken: Token | undefined;
  quoteToken: Token | undefined;
  setValue: UseFormSetValue<TradeFormData>;
}

export function usePriceSelection({
  orderType,
  priceDecimals,
  selectedMarket,
  baseToken,
  quoteToken,
  setValue,
}: UsePriceSelectionParams) {
  const selectedPrice = useExchangeStore((state) => state.selectedPrice);
  const setSelectedPrice = useExchangeStore((state) => state.setSelectedPrice);

  useEffect(() => {
    if (selectedPrice !== null && selectedMarket && baseToken && quoteToken) {
      // Auto-switch to limit order if currently on market order
      if (orderType === "market") {
        setValue("orderType", "limit");
      }

      // Round price to tick size and set it
      const rounded = roundToTickSize(selectedPrice, selectedMarket.tick_size, quoteToken.decimals);
      setValue("price", rounded.toFixed(priceDecimals));

      // Clear the selected price from store
      setSelectedPrice(null);
    }
  }, [selectedPrice, selectedMarket, baseToken, quoteToken, orderType, setSelectedPrice, setValue, priceDecimals]);
}
