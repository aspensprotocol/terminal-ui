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
