/**
 * Hidden-order toggle for the trade panel.
 *
 * A hidden order is matched normally (same price-time priority) but is
 * excluded from the public orderbook stream and depth, and its fills
 * print with this side's identity redacted. It appears in NO public
 * feed — not even to its owner — so the UI tracks it locally only
 * (see the `hiddenOrders` store slice); its status won't auto-update
 * after fills.
 *
 * Valid for both limit and market orders — the parent renders it
 * unconditionally, unlike `PostOnlyToggle`.
 */

interface HiddenToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

export function HiddenToggle({ value, onChange }: HiddenToggleProps) {
  return (
    <label
      className="flex items-center gap-2 cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground transition-colors"
      title="Invisible to the market: excluded from the public orderbook and depth; fills print with your side redacted. Tracked locally only — status won't auto-update after fills."
    >
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border border-border bg-background text-primary focus:ring-1 focus:ring-primary focus:ring-offset-0 cursor-pointer"
      />
      <span>Hidden order</span>
    </label>
  );
}
