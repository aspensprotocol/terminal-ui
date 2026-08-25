/**
 * Per-leg settlement addresses for order entry.
 *
 * An order carries one account address per chain leg
 * (`Order.base_account_address` / `Order.quote_account_address`), and those
 * are the SETTLEMENT addresses: the venue credits fill proceeds to the
 * exact strings the signed order carries. Only the collateral-side address
 * is authenticated by the envelope signature — the receiving-side address
 * is asserted by the signer — and funds credited to an address are
 * withdrawable only by the holder of that address's key. A malformed or
 * mistyped address is therefore stranded funds, and the place to catch it
 * is before signing.
 *
 * The Rust SDK carries the same contract in
 * `aspens::orders::validate_settle_address` and the send-order leg
 * resolution; the arborter enforces the format half of it at `SendOrder`
 * entry. Behavior changes must land in all three.
 */

import { PublicKey } from "@solana/web3.js";
import { checksumAddress } from "viem";

const isSolana = (architecture: string) =>
  architecture.toLowerCase() === "solana";

/**
 * Why `address` is not usable as a settlement address on a chain of
 * `architecture` — or `null` if it is.
 *
 * Rules (mirroring the arborter's entry validation):
 * - Solana architecture: base58 decoding to exactly 32 bytes.
 * - Everything else (EVM): a `0x`-prefixed 20-byte hex string. The prefix
 *   is required — the venue's ledger only canonicalizes `0x`-prefixed
 *   addresses, so an unprefixed spelling would key a separate balance.
 *
 * Plus one stricter, client-only rule: a MIXED-CASE EVM address claims an
 * EIP-55 checksum and is refused when that checksum is wrong. The venue
 * deliberately accepts any casing (the field sits inside the signature and
 * is echoed byte-verbatim), so catching the typo is the client's job or
 * nobody's.
 */
export function validateSettleAddress(
  architecture: string,
  address: string,
): string | null {
  if (isSolana(architecture)) {
    try {
      // PublicKey enforces base58 decoding to exactly 32 bytes.
      new PublicKey(address);
      return null;
    } catch {
      return `"${address}" is not a valid Solana address (base58, 32 bytes)`;
    }
  }

  if (!address.startsWith("0x")) {
    return (
      `"${address}" must carry the 0x prefix — the venue's ledger only ` +
      "canonicalizes 0x-prefixed addresses, so an unprefixed spelling " +
      "would key a separate balance"
    );
  }
  const body = address.slice(2);
  if (body.length !== 40 || !/^[0-9a-fA-F]*$/.test(body)) {
    return `"${address}" must be exactly 20 bytes of hex after the 0x prefix`;
  }
  const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  if (mixedCase && checksumAddress(address as `0x${string}`) !== address) {
    return (
      `"${address}" is mixed-case but fails its EIP-55 checksum — likely a ` +
      "typo; paste the address exactly, or all-lowercase to skip the check"
    );
  }
  return null;
}

/**
 * Two spellings of one address, judged by the chain's rules: EVM hex is
 * case-insensitive, base58 is not.
 */
export function sameSettleAddress(
  architecture: string,
  a: string,
  b: string,
): boolean {
  return isSolana(architecture) ? a === b : a.toLowerCase() === b.toLowerCase();
}

export interface ResolveLegAddressesParams {
  side: "buy" | "sell";
  baseArchitecture: string;
  quoteArchitecture: string;
  /** The connected wallet's address on the base chain, if any. */
  baseWalletAddress: string | null;
  /** The connected wallet's address on the quote chain, if any. */
  quoteWalletAddress: string | null;
  baseOverride?: string;
  quoteOverride?: string;
}

/**
 * Decide the order's two account addresses from the connected wallets and
 * the caller's optional overrides. Throws with a user-presentable message
 * when the combination is not signable or not settleable.
 *
 * - No override → the wallet's address on that leg (the long-standing
 *   default), which must exist on the GIVE leg (it is the signer) and on
 *   the RECEIVE leg unless an override supplies the address instead.
 * - The GIVE leg (buy → quote, sell → base) is what the venue verifies the
 *   envelope signature against and draws collateral from: an override
 *   there may only restate the signing wallet's own address.
 * - The RECEIVE leg is where proceeds settle; an override there is
 *   "settle to a different address", validated for the leg's chain and
 *   kept byte-verbatim — the caller's spelling is what gets signed.
 *
 * What this cannot check: that anyone holds the key to a redirected
 * address. The venue has no address registry, and funds credited there are
 * withdrawable only by that key's holder. Surfaces presenting this to
 * users must say so.
 */
export function resolveLegAddresses(params: ResolveLegAddressesParams): {
  baseAddress: string;
  quoteAddress: string;
} {
  const giveIsQuote = params.side === "buy";

  const resolve = (
    leg: "base" | "quote",
    architecture: string,
    walletAddress: string | null,
    override: string | undefined,
    isGive: boolean,
  ): string => {
    if (override === undefined) {
      if (walletAddress === null) {
        throw new Error(
          isGive
            ? `no connected wallet for the ${leg} chain — this order gives ` +
                `${leg} and must be signed by a ${architecture} wallet`
            : `no settlement address for the ${leg} leg — connect a ` +
                `${architecture} wallet or enter an address to settle to`,
        );
      }
      return walletAddress;
    }
    const invalid = validateSettleAddress(architecture, override);
    if (invalid !== null) {
      throw new Error(`${leg} settlement address rejected: ${invalid}`);
    }
    if (isGive) {
      if (walletAddress === null) {
        throw new Error(
          `no connected wallet for the ${leg} chain — this order gives ` +
            `${leg}, and the venue verifies the signature against that ` +
            "address, so an entered address cannot stand in for the wallet",
        );
      }
      if (!sameSettleAddress(architecture, override, walletAddress)) {
        throw new Error(
          `the ${leg} leg is what this order GIVES: the venue verifies the ` +
            "envelope signature against that address and draws collateral " +
            `from it, so it must be the signing wallet's own address ` +
            `${walletAddress}. To settle proceeds to a different address, ` +
            "redirect the receiving leg instead",
        );
      }
    }
    return override;
  };

  return {
    baseAddress: resolve(
      "base",
      params.baseArchitecture,
      params.baseWalletAddress,
      params.baseOverride,
      !giveIsQuote,
    ),
    quoteAddress: resolve(
      "quote",
      params.quoteArchitecture,
      params.quoteWalletAddress,
      params.quoteOverride,
      giveIsQuote,
    ),
  };
}
