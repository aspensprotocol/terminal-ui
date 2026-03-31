"use client";

interface SpreadIndicatorProps {
  spreadPercentage: string;
  spreadValue?: string;
}

export function SpreadIndicator({ spreadPercentage, spreadValue: _spreadValue }: SpreadIndicatorProps) {
  return (
    <div className="flex items-center justify-center py-0.5 shrink-0 bg-muted/30">
      <div className="flex-1 border-t border-border/50"></div>
      <div className="px-2 flex flex-col items-center gap-0.5">
        <span className="text-[10px] text-muted-foreground/70 font-medium uppercase tracking-wider">Spread</span>
        <span className="text-xs text-foreground font-mono font-semibold tabular-nums">{spreadPercentage}%</span>
      </div>
      <div className="flex-1 border-t border-border/50"></div>
    </div>
  );
}
