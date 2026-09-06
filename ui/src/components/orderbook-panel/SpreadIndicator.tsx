"use client";

interface SpreadIndicatorProps {
  spreadPercentage: string;
  spreadValue?: string;
  /**
   * Set when the best bid on one composite member is above the best ask on
   * another. Members are independent books, so this is a normal state, not
   * an error — but a bare percentage would render as a nonsensical negative
   * "SPREAD", so it renders the word "Crossed" instead. Single-market books
   * never pass this (always one book, so it can't be crossed).
   */
  crossed?: boolean;
}

export function SpreadIndicator({
  spreadPercentage,
  spreadValue: _spreadValue,
  crossed = false,
}: SpreadIndicatorProps) {
  return (
    <div className="flex items-center justify-center py-0.5 shrink-0 bg-muted/30">
      <div className="flex-1 border-t border-border/50"></div>
      <div className="px-2 flex flex-col items-center gap-0.5">
        <span className="text-[10px] text-muted-foreground/70 font-medium uppercase tracking-wider">
          Spread
        </span>
        {crossed ? (
          <span
            className="text-xs text-amber-500 font-mono font-semibold"
            title="Best bid on one market is above the best ask on another; the books are independent"
          >
            Crossed
          </span>
        ) : (
          <span className="text-xs text-foreground font-mono font-semibold tabular-nums">
            {spreadPercentage}%
          </span>
        )}
      </div>
      <div className="flex-1 border-t border-border/50"></div>
    </div>
  );
}
