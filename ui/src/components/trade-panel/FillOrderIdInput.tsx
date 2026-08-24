/**
 * Dealroom "discretionary" fill-by-order-id input for the trade panel.
 *
 * Optional. When the user enters a resting order's id here, the order sent
 * carries `executionType: DISCRETIONARY` and `matchingOrderIds: [id]` — it
 * fills ONLY against that maker's resting order, at that maker's price,
 * gated by this order's own limit price. It is IOC: whatever doesn't fill
 * against that id never rests. Leaving the field empty keeps today's
 * behavior byte-identical (`executionType: UNSPECIFIED`).
 *
 * v1 carries a single id — the wire field is a repeated list (1..16), but
 * the form only ever produces a 0- or 1-element array.
 *
 * Limit-only: the parent (`TradePanel`) gates rendering on
 * `orderType === "limit"`, matching `PostOnlyToggle` — a discretionary fill
 * is gated by this order's limit price, so there's nothing to gate against
 * on a market order.
 *
 * DISABLED under the FCE transport. The ext-proxy's direct-action payload
 * carries no `matching_order_ids` field, so the adapter would reconstruct
 * the order without it and the signature — which covers it — would no
 * longer verify. The SDK throws for exactly this reason; disabling the
 * control turns that into something the user can see before they submit
 * rather than an error afterwards.
 *
 * `maxLength` caps entry at 66 characters — `0x` plus the 64 hex digits of
 * a full 32-byte order id — as a typing-time nudge only. It is not the
 * validation: `useTradeFormSubmit` re-checks the exact `0x` + 64-hex-digit
 * shape synchronously before signing, since a pasted value can still be the
 * wrong length or carry non-hex characters.
 */

"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFceEnabled } from "@/lib/providers/fce-context";

interface FillOrderIdInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function FillOrderIdInput({ value, onChange }: FillOrderIdInputProps) {
  const fceEnabled = useFceEnabled();
  const title = fceEnabled
    ? "Unavailable on this deployment: dealroom fill-by-order-id is not supported over the FCE direct-action transport."
    : "Fill only against this resting order id, at its maker's price, gated by your limit price above. IOC — anything left over never rests.";

  return (
    <div className="space-y-1.5" title={title}>
      <Label className="text-xs font-medium text-muted-foreground">
        Fill order ID (optional)
      </Label>
      <Input
        type="text"
        inputMode="text"
        pattern="0x[0-9a-fA-F]*"
        maxLength={66}
        value={fceEnabled ? "" : value}
        disabled={fceEnabled}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const hasPrefix = raw.toLowerCase().startsWith("0x");
          const hex = (hasPrefix ? raw.slice(2) : raw).replace(
            /[^0-9a-fA-F]/g,
            "",
          );
          onChange(hex ? `0x${hex}` : "");
        }}
        placeholder="0x-prefixed resting order id"
        className="font-mono h-9 text-sm border-border/40 focus:border-primary/50 focus:ring-1 focus:ring-primary/20 bg-muted/20 disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}
