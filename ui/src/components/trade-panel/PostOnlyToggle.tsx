/**
 * GTC / Post-Only toggle for the trade panel.
 *
 * Two segments over one boolean. "GTC" (the default) is an ordinary limit
 * order: it takes whatever crosses and rests the remainder until filled or
 * cancelled. "Post-Only" tells arborter to reject the order if it would
 * cross at submission (FAILED_PRECONDITION, no on-chain lock, no gas spent).
 *
 * Only meaningful for limit orders — the parent (`TradePanel`) gates
 * rendering on `orderType === "limit"` and resets the value to `false`
 * when the user switches to market. This component itself is purely
 * controlled and makes no assumptions about the parent's state.
 */

import { Button } from "@/components/ui/button";

interface PostOnlyToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

const SEGMENTS = [
  {
    postOnly: false,
    label: "GTC",
    title: "Good 'til cancelled: fills what crosses, rests the rest.",
  },
  {
    postOnly: true,
    label: "Post-Only",
    title:
      "Reject the order if it would cross at submission (maker-only). No on-chain lock is performed on rejection.",
  },
] as const;

export function PostOnlyToggle({ value, onChange }: PostOnlyToggleProps) {
  return (
    <div className="grid grid-cols-2 gap-1.5" role="radiogroup">
      {SEGMENTS.map(({ postOnly, label, title }) => (
        <Button
          key={label}
          type="button"
          role="radio"
          aria-checked={value === postOnly}
          variant="outline"
          size="sm"
          onClick={() => onChange(postOnly)}
          title={title}
          className={`h-7 text-xs font-medium ${
            value === postOnly
              ? "border-primary/60 bg-primary/10 text-primary hover:bg-primary/15"
              : "text-muted-foreground"
          }`}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
