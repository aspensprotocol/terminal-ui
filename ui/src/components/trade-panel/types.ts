/**
 * Shared types for the trade-panel and its hooks.
 *
 * Hoisted out of `TradePanel.tsx` / `useTradeFormSubmit.ts` /
 * `usePriceSelection.ts` / `useOrderEstimate.ts` (which each kept their
 * own copies) so adding a form field is a one-line change in one file
 * instead of a mechanical sweep — see how `postOnly` got added across
 * three matching `TradeFormData` declarations before this refactor.
 *
 * Inline `"buy" | "sell"` / `"limit" | "market"` literals in the leaf
 * sub-components (`SideSelector`, `OrderTypeSelector`, etc.) have also
 * been replaced with imports from here so the canonical definition is
 * here only.
 */

export type OrderSide = "buy" | "sell";

export type OrderType = "limit" | "market";

export interface TradeFormData {
  side: OrderSide;
  orderType: OrderType;
  price: string;
  size: string;
  /**
   * Post-only flag — only meaningful for limit orders. The form may
   * keep it set across an orderType change, but `useTradeFormSubmit`
   * guards against that by forcing it to `false` when `orderType` is
   * not `"limit"`. The signing data and the SDK call both read the
   * same guarded value, keeping the signed digest and the wire request
   * in lock-step.
   */
  postOnly: boolean;
}
