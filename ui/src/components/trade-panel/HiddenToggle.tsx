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
 *
 * DISABLED under the FCE transport. The adapter's `PlaceOrderRequest` carries
 * no `hidden` field, so it reconstructs the order with `hidden=false` and the
 * signature — which covers `hidden` — no longer verifies. The SDK throws for
 * exactly this reason; disabling the control turns that into something the user
 * can see before they submit rather than an error afterwards.
 */

"use client";

import { useFceEnabled } from "@/lib/providers/fce-context";

interface HiddenToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

export function HiddenToggle({ value, onChange }: HiddenToggleProps) {
  const fceEnabled = useFceEnabled();
  const title = fceEnabled
    ? "Unavailable on this deployment: hidden orders are not supported over the FCE direct-action transport."
    : "Invisible to the market: excluded from the public orderbook and depth; fills print with your side redacted. Tracked locally only — status won't auto-update after fills.";

  return (
    <label
      className={`flex items-center gap-2 select-none text-xs transition-colors ${
        fceEnabled
          ? "cursor-not-allowed text-muted-foreground/50"
          : "cursor-pointer text-muted-foreground hover:text-foreground"
      }`}
      title={title}
    >
      <input
        type="checkbox"
        checked={fceEnabled ? false : value}
        disabled={fceEnabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border border-border bg-background text-primary focus:ring-1 focus:ring-primary focus:ring-offset-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      />
      <span>Hidden order</span>
    </label>
  );
}
