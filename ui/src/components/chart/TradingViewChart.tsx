"use client";

import { useEffect, useRef, useState } from "react";
import { useExchangeStore } from "@/lib/store";
import { ExchangeDatafeed } from "@/components/chart/tradingview-datafeed";
import { Card, CardContent } from "@/components/ui/card";
import { useOrderLines } from "./useOrderLines";
import { getChartConfig } from "./chartConfig";

import type {
  IChartingLibraryWidget,
  ChartingLibraryWidgetOptions,
} from "../../../public/vendor/trading-view/charting_library";

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: ChartingLibraryWidgetOptions) => IChartingLibraryWidget;
    };
  }
}

export function TradingViewChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const datafeedRef = useRef<ExchangeDatafeed | null>(null);
  const selectedMarketId = useExchangeStore((state) => state.selectedMarketId);
  const [isChartReady, setIsChartReady] = useState(false);

  // Manage order lines overlay (orders are subscribed to at the page level)
  useOrderLines(widgetRef, isChartReady);

  useEffect(() => {
    if (!containerRef.current || !selectedMarketId) {
      return;
    }

    if (typeof window === "undefined" || !window.TradingView) {
      console.error("[TradingView] Library not loaded");
      return;
    }

    const TradingView = window.TradingView;

    // Create datafeed once and reuse
    if (!datafeedRef.current) {
      datafeedRef.current = new ExchangeDatafeed();
    }

    const widgetOptions = getChartConfig(selectedMarketId, datafeedRef.current, containerRef.current);

    try {
      const widget = new TradingView.widget(widgetOptions);
      widgetRef.current = widget;

      widget.onChartReady(() => {
        widget.activeChart().setChartType(1); // Force candlestick
        setIsChartReady(true);
      });
    } catch (error) {
      console.error("[TradingView] Failed to create widget:", error);
    }

    return () => {
      if (widgetRef.current) {
        widgetRef.current.remove();
        widgetRef.current = null;
      }
      setIsChartReady(false);
    };
  }, [selectedMarketId]);

  if (!selectedMarketId) {
    return (
      <Card className="flex items-center justify-center h-full min-h-[400px]">
        <CardContent className="p-6">
          <p className="text-gray-500 text-sm">Select a market to view chart</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden h-full p-0 border border-gray-800/40 shadow-lg shadow-primary/5">
      <div ref={containerRef} className="h-full w-full" />
    </Card>
  );
}
