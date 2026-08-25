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
  /**
   * Hidden ("invisible") order — valid for BOTH limit and market
   * orders (a hidden market order is an anonymous taker), so unlike
   * postOnly it is neither gated on orderType nor reset on a switch.
   */
  hidden: boolean;
  /**
   * Dealroom "discretionary" fill — resting order ids (as `0x`-prefixed
   * 32-byte hex strings, `bytes` on the wire) this order is restricted to
   * matching against. v1
   * carries at most one id, entered via a single "Fill order ID" input, but
   * the form field and the signed proto field are both arrays (0 or 1
   * elements here) so this threads straight into
   * `OrderSigningData.matchingOrderIds` with no reshaping.
   *
   * Limit-only, like `postOnly` — a discretionary fill is gated by this
   * order's own limit price, so `useTradeFormSubmit` guards it the same
   * way: forced to empty when `orderType` is not `"limit"`.
   */
  matchingOrderIds?: string[];
  /**
   * Settle the RECEIVING leg (buy → base, sell → quote) to an address
   * other than the connected wallet's. The address itself is
   * `settleAddress`; this flag is the user's explicit opt-in, so a
   * leftover address string can never silently redirect an order after
   * the toggle was turned back off.
   */
  settleToDifferent: boolean;
  /**
   * The settlement address for the receiving leg when
   * `settleToDifferent` is on — or, on a market whose receiving chain
   * has no connected wallet, the mandatory settlement address. Kept
   * byte-verbatim: the venue credits (and the wallet signs) this exact
   * string.
   */
  settleAddress: string;
  /**
   * Per-order acknowledgement that a REDIRECTED settlement address is
   * meant: the venue cannot check anyone holds its key, and funds
   * credited there are withdrawable only by that key's holder. Never
   * persisted — every redirected order re-asks. Reset on submit success.
   */
  settleRedirectAck: boolean;
  /**
   * Acknowledgement that an EVM/EVM market settles BOTH legs to the one
   * connected address. Only consulted when that situation is on screen
   * and the wallet hasn't acknowledged it before (see
   * `lib/settlement-ack.ts` — checking the box is what persists it).
   */
  sameAddressAck: boolean;
}
