import { useMemo } from "react";

interface OrderEstimateParams {
  price: string;
  size: string;
  side: "buy" | "sell";
  orderType: "limit" | "market";
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  makerFeeBps: number;
  takerFeeBps: number;
}

export interface OrderEstimate {
  price: number;
  size: number;
  total: number;
  fee: number;
  finalAmount: number;
}

export function useOrderEstimate({
  price,
  size,
  side,
  orderType,
  bestBid,
  bestAsk,
  lastTradePrice,
  makerFeeBps,
  takerFeeBps,
}: OrderEstimateParams): OrderEstimate | null {
  return useMemo(() => {
    const priceNum = parseFloat(price);
    const sizeNum = parseFloat(size);

    let effectivePrice = 0;
    if (orderType === "limit") {
      effectivePrice = priceNum;
    } else {
      effectivePrice = (side === "buy" ? bestAsk : bestBid) || lastTradePrice || 0;
    }

    if (isNaN(effectivePrice) || effectivePrice <= 0 || isNaN(sizeNum) || sizeNum <= 0) {
      return null;
    }

    const total = effectivePrice * sizeNum;
    const feeBps = orderType === "market" ? takerFeeBps : makerFeeBps;
    const fee = (total * Math.abs(feeBps)) / 10000;
    const finalAmount = side === "buy" ? total + fee : total - fee;

    return {
      price: effectivePrice,
      size: sizeNum,
      total,
      fee,
      finalAmount,
    };
  }, [price, size, side, orderType, bestBid, bestAsk, lastTradePrice, makerFeeBps, takerFeeBps]);
}
