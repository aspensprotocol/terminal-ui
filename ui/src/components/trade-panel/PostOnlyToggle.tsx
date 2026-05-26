/**
 * Post-only toggle for the trade panel.
 *
 * Renders a small inline checkbox + label. When the user checks it, the
 * order submission tells arborter to reject the order if it would cross
 * at submission (FAILED_PRECONDITION, no on-chain lock, no gas spent).
 *
 * Only meaningful for limit orders — the parent (`TradePanel`) gates
 * rendering on `orderType === "limit"` and resets the value to `false`
 * when the user switches to market. This component itself is purely
 * controlled and makes no assumptions about the parent's state.
 */

interface PostOnlyToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

export function PostOnlyToggle({ value, onChange }: PostOnlyToggleProps) {
  return (
    <label
      className="flex items-center gap-2 cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground transition-colors"
      title="Reject the order if it would cross at submission (maker-only). No on-chain lock is performed on rejection."
    >
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border border-border bg-background text-primary focus:ring-1 focus:ring-primary focus:ring-offset-0 cursor-pointer"
      />
      <span>Post-only</span>
    </label>
  );
}
