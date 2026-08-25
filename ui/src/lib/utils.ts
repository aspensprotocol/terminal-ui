import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * EVM addresses compare case-insensitively (EIP-55 checksums are display
 * only); the arborter emits its canonical lowercase form on trade taker
 * fields, while wallets hand us checksummed strings. Neither `undefined`
 * nor `null` ever equals anything (including another absent value) —
 * mirrors the store's hidden-order compare, and accepts `null` because
 * the store's `userAddress` is typed `string | null`.
 */
export function sameAddress(a?: string | null, b?: string | null): boolean {
  return a != null && b != null && a.toLowerCase() === b.toLowerCase();
}

/**
 * Shorten an address for display: `0x1234…abcd` / `9xkQ…P2Vf`. Keeps
 * enough of each end to spot-check against a wallet, no more — full
 * addresses belong in `title` attributes, not in layout.
 */
export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
