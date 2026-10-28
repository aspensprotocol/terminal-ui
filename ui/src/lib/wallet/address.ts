/**
 * The address edge between what people read and type and what the venue
 * keys.
 *
 * Inside the venue a Tron account is `0x` hex, exactly as an EVM one: the
 * ledger, the signed order and the gRPC wire all carry the 20 bytes that
 * way, and a `T…` string sent to the venue is refused. The base58check
 * `T…` form exists only here, at the human edge: Tron addresses are shown
 * in it, and a settlement address typed in it is converted to hex before it
 * is signed.
 */

import {
  hexToTron,
  parseArchitecture,
  tronToHex,
  validateSettleAddress,
} from "@aspensprotocol/sdk-ts";
import type { ChainEcosystem } from "./types";

/**
 * How to show `address` (as the venue keys it) on a chain of `ecosystem`: a
 * Tron account in its `T…` form, everything else as it is. A Tron value
 * that is not a 20-byte hex account (a placeholder such as "—") is shown
 * unchanged.
 */
export function displayAddress(
  ecosystem: ChainEcosystem,
  address: string,
): string {
  if (ecosystem !== "tron") return address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return address;
  return hexToTron(address);
}

/** A settlement address to sign, or why the input cannot be one. */
export type SettleOverride =
  | { address: string; error: null }
  | { address: null; error: string };

/**
 * Turn a typed settlement address into the string the order signs, under
 * the receiving chain's rules.
 *
 * On a Tron chain a `T…` address is accepted and converted to lowercase
 * `0x` hex (its checksum is checked on the way); `0x` hex is accepted as
 * typed. Every other architecture keeps the SDK's validation and the
 * caller's exact spelling. Surrounding whitespace is dropped.
 */
export function settleOverrideAddress(
  architecture: string,
  input: string,
): SettleOverride {
  let candidate = input.trim();
  if (parseArchitecture(architecture) === "tron" && candidate.startsWith("T")) {
    try {
      candidate = tronToHex(candidate);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return {
        address: null,
        error: `"${candidate}" is not a valid Tron address: ${why}`,
      };
    }
  }
  const error = validateSettleAddress(architecture, candidate);
  return error === null
    ? { address: candidate, error: null }
    : { address: null, error };
}
