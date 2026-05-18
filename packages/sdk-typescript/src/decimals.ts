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
