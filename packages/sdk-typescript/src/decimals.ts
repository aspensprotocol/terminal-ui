/**
 * Decimal conversion helpers shared by adapters and the public API.
 *
 * The arborter wire format encodes prices/sizes as decimal-string integers
 * scaled by `pair_decimals` (e.g. "1500000000000000000" for 1.5 when
 * pair_decimals = 18). Balances arrive scaled by token decimals. These helpers
 * convert between scaled integers and human-readable strings without going
 * through `Number`, which would silently lose precision for large values.
 */

/**
 * Default cap on fractional digits when rendering for humans.
 *
 * Most markets quote in 6 (USDC) or 8 (BTC) decimals; some use 18. Showing 18
 * trailing digits is unreadable, so the display layer caps here. The raw
 * `priceValue` / `sizeValue` numeric fields still carry full float precision
 * for math; this only affects the formatted string.
 */
export const DEFAULT_DISPLAY_DECIMALS = 8;

/**
 * Convert a raw scaled-integer string to a human-readable decimal string.
 *
 * Operates on the string directly (no parseFloat / Number / BigInt cast)
 * so precision is preserved for arbitrarily-large values.
 *
 * Trailing zeros in the fractional part are stripped: "1500000" with
 * decimals=6 returns "1.5", not "1.500000".
 */
export function toDisplayValue(
  value: string | number,
  decimals: number,
): string {
  if (typeof value === "number") {
    value = value.toString();
  }

  if (value === "0" || value === "") return "0";

  const isNegative = value.startsWith("-");
  if (isNegative) value = value.slice(1);

  while (value.length <= decimals) {
    value = "0" + value;
  }

  const intPart = value.slice(0, -decimals) || "0";
  const decPart = decimals > 0 ? value.slice(-decimals) : "";

  const trimmedDec = decPart.replace(/0+$/, "");
  const result = trimmedDec ? `${intPart}.${trimmedDec}` : intPart;
  return isNegative ? `-${result}` : result;
}

/**
 * Like {@link toDisplayValue} but caps the fractional part at `maxDecimals`
 * (default {@link DEFAULT_DISPLAY_DECIMALS}). Trailing zeros are stripped
 * after capping.
 *
 * Use this when rendering values whose underlying precision can be very high
 * (e.g. a market with pair_decimals=18) — the cap keeps the UI readable
 * without changing the canonical numeric value held in `priceValue` etc.
 */
export function toDisplayValueCapped(
  value: string | number,
  decimals: number,
  maxDecimals: number = DEFAULT_DISPLAY_DECIMALS,
): string {
  const full = toDisplayValue(value, decimals);
  const dot = full.indexOf(".");
  if (dot < 0) return full;
  const fractional = full.slice(dot + 1);
  if (fractional.length <= maxDecimals) return full;
  const truncated = fractional.slice(0, maxDecimals).replace(/0+$/, "");
  return truncated ? `${full.slice(0, dot)}.${truncated}` : full.slice(0, dot);
}

/**
 * Format an already-human-readable decimal number for display, applying the
 * standard cap-then-strip-trailing-zeros rule.
 *
 * Use when the source is a JS number (e.g. computed `priceValue * sizeValue`)
 * rather than a raw scaled integer.
 */
export function formatDisplayNumber(
  value: number,
  maxDecimals: number = DEFAULT_DISPLAY_DECIMALS,
): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  const fixed = value.toFixed(maxDecimals);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

/**
 * Optional sign, digits with an optional decimal point, optional exponent.
 * Anchored, so anything else — a stray comma, "1.2.3", "abc", "" — fails to
 * match and is rejected rather than silently becoming a number.
 */
const DECIMAL_PATTERN = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Convert a human-typed decimal string to the raw scaled integer the wire
 * carries, using string and BigInt arithmetic only.
 *
 * This is the ONLY sanctioned direction of travel for an amount that will be
 * signed. The obvious alternative — `Math.round(parseFloat(s) * 10 ** d)` —
 * cannot be trusted at the scales this exchange uses: `10 ** 18` is not
 * exactly representable as a double, so the product lands on whatever multiple
 * of the local float spacing happens to be nearest. At 18 pair decimals a
 * price of `1.1` comes out as 1100000000000000128 instead of
 * 1100000000000000000. That is not a rounding curiosity: the arborter verifies
 * the envelope signature against the prost re-encoding of the `Order` it
 * receives, so a value computed one way in the bytes the wallet signs and
 * another way in the bytes that go on the wire recovers a DIFFERENT address
 * and the order is refused for a bad signature, saying nothing about the
 * number that moved. Derive the raw value once, here, and thread that one
 * value everywhere.
 *
 * Digits finer than `decimals` are TRUNCATED toward zero, never rounded up:
 * the scale cannot represent them, and truncation can only ever ask for less
 * than the user typed. `decimals` is the market's `pair_decimals` for a
 * price/size; a token's own decimals for a native-unit amount.
 *
 * Throws on anything that isn't a decimal number — a malformed amount must
 * stop the submission, not become a silent zero (`parseFloat("abc")` is `NaN`,
 * and `Math.round(NaN)` used to reach `BigInt()` as a thrown RangeError with
 * no useful text).
 */
export function decimalToRaw(decimal: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimalToRaw: invalid scale ${decimals}`);
  }

  const match = DECIMAL_PATTERN.exec(decimal.trim());
  // `m[2]` and `m[3]` are both optional in the pattern, so "" and "." match it
  // while carrying no digits at all; require at least one digit somewhere.
  if (!match || (!match[2] && !match[3])) {
    throw new Error(
      `decimalToRaw: not a decimal number: ${JSON.stringify(decimal)}`,
    );
  }

  const negative = match[1] === "-";
  const intDigits = match[2] ?? "";
  const fracDigits = match[3] ?? "";
  const exponent = match[4] ? Number(match[4]) : 0;
  // An exponent only shifts where the point sits; a wild one would ask for a
  // string of zeros no amount could need. Reject it rather than allocate it.
  if (!Number.isFinite(exponent) || Math.abs(exponent) > 1000) {
    throw new Error(
      `decimalToRaw: exponent out of range in ${JSON.stringify(decimal)}`,
    );
  }

  const digits = intDigits + fracDigits;
  // Where the decimal point sits within `digits` once the exponent is applied,
  // then shifted right by `decimals` — which is exactly what scaling by
  // 10**decimals does. Everything left of `cut` is the raw integer; everything
  // right of it is below the scale's precision and is dropped.
  const cut = intDigits.length + exponent + decimals;

  let raw: bigint;
  if (cut <= 0) {
    raw = 0n;
  } else if (cut >= digits.length) {
    raw = BigInt(digits.padEnd(cut, "0") || "0");
  } else {
    raw = BigInt(digits.slice(0, cut) || "0");
  }

  // -0 is 0; don't emit a signed zero.
  return negative && raw !== 0n ? (-raw).toString() : raw.toString();
}

export interface MarketBidQuoteBudgetOpts {
  /** Base quantity the user wants, as a pair-decimal-scaled integer string. */
  sizeRaw: string;
  /**
   * Quote-per-base price to size the budget with, pair-decimal-scaled. A
   * market order has no price of its own, so this is a *reference* price
   * (best ask / last trade) — see the caller's slippage caveat.
   */
  referencePriceRaw: string;
  /** The market's `pair_decimals` — the scale of `sizeRaw` / `referencePriceRaw`. */
  pairDecimals: number;
  /** The QUOTE token's own decimals on its chain (`Market.quoteChainTokenDecimals`). */
  quoteTokenDecimals: number;
}

/**
 * Size a market BID's `Order.quote_budget`, in the quote token's NATIVE base
 * units.
 *
 * Two scales meet here and they are routinely different (e.g. pair_decimals=18
 * against USDC's 6). The matching engine works in pair decimals; `quote_budget`
 * is denominated in the quote token's own decimals — the denomination the
 * ledger reserves in. A figure at the wrong scale is *accepted* by the arborter
 * and mis-collateralises the order rather than being rejected, so the
 * conversion happens once, here, in BigInt.
 *
 * The arithmetic deliberately mirrors the arborter's own limit-bid derivation
 * (`handlers::common::required_collateral`): multiply, drop one factor of the
 * pair scale, then re-scale pair → quote-token decimals. Both steps FLOOR, so
 * the committed budget is never larger than the quote the order was sized to
 * spend.
 *
 * Returns a `bigint` that may be `0n` — either because the inputs were zero or
 * because the budget floored away below the quote token's precision. Callers
 * must refuse a zero budget: the arborter rejects one (it can buy nothing), so
 * sending it just turns a clear client-side error into a server round-trip.
 */
export function marketBidQuoteBudget(opts: MarketBidQuoteBudgetOpts): bigint {
  const { sizeRaw, referencePriceRaw, pairDecimals, quoteTokenDecimals } = opts;
  const size = BigInt(sizeRaw);
  const price = BigInt(referencePriceRaw);
  if (size <= 0n || price <= 0n) return 0n;

  // size * price is scaled by pair_decimals TWICE; one factor comes back out
  // to leave the quote amount in pair units.
  const quoteInPairUnits = (size * price) / 10n ** BigInt(pairDecimals);

  return quoteTokenDecimals >= pairDecimals
    ? quoteInPairUnits * 10n ** BigInt(quoteTokenDecimals - pairDecimals)
    : quoteInPairUnits / 10n ** BigInt(pairDecimals - quoteTokenDecimals);
}
