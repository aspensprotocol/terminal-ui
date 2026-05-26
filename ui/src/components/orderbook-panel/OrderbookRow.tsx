"use client";

interface OrderbookRowProps {
  price: string;
  priceValue: number;
  size: string;
  cumulative: number;
  maxCumulative: number;
  type: "bid" | "ask";
  /**
   * Resting order was submitted as post-only. Each orderbook row is a
   * single order (not a price-level aggregate), so this flag is exact
   * per-row. Renders a small "PO" badge inline next to the price.
   */
  postOnly?: boolean;
  onClick: (price: number) => void;
}

export function OrderbookRow({
  price,
  priceValue,
  size,
  cumulative,
  maxCumulative,
  type,
  postOnly,
  onClick,
}: OrderbookRowProps) {
  const depthPercentage = (cumulative / maxCumulative) * 100;
  const isBid = type === "bid";
  const colorClass = isBid ? "text-green-500" : "text-red-500";
  const bgClass = isBid ? "bg-green-500/10" : "bg-red-500/10";
  const hoverClass = isBid ? "hover:bg-green-500/20" : "hover:bg-red-500/20";

  return (
    <div
      onClick={() => onClick(priceValue)}
      className={`relative flex justify-between text-[11px] leading-tight ${hoverClass} px-3 py-0.5 cursor-pointer font-mono tabular-nums`}
    >
      {/* Depth background */}
      <div
        className={`absolute left-0 top-0 bottom-0 ${bgClass} transition-all duration-300 ease-out`}
        style={{ width: `${depthPercentage}%` }}
      />
      <span
        className={`relative z-10 ${colorClass} font-semibold whitespace-nowrap flex items-center gap-1`}
      >
        {price}
        {postOnly && (
          <span
            className="text-[8px] font-bold tracking-wide bg-amber-500/20 text-amber-500 px-1 rounded-sm leading-none py-[1px]"
            title="Post-only: this resting order is guaranteed not to take liquidity"
          >
            PO
          </span>
        )}
      </span>
      <span className="relative z-10 text-muted-foreground text-right whitespace-nowrap">
        {size}
      </span>
    </div>
  );
}
