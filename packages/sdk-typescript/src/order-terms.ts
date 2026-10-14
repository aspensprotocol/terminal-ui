/**
 * Order terms exchanged between two counterparties, and the check that a
 * stated order id really is the order those terms describe.
 *
 * Two parties who agree a trade out of band pass each other one line of text:
 *
 *     aspens-otc:v1:<base64url(JSON)>
 *
 * whose JSON carries exactly `market_id`, `side`, `qty`, `price`, `nonce`,
 * `owner` and `id`. The receiver recomputes the id from the other six fields
 * and the venue's own configuration, and acts on the order only if it matches.
 *
 * # What a match proves
 *
 * The id is a hash over the signer's address, the nonce, both chain ids, both
 * token address strings and the two native-unit amounts — and the arborter
 * derives it from the order it verified the owner's signature over. So an id
 * that matches these terms names an order `owner` signed for exactly this
 * market, side, quantity and price — up to the precision of the two tokens.
 * The amounts are hashed in each token's NATIVE units, floored from pair
 * units, so terms whose qty or price differ only below that precision derive
 * the same id and verify. The difference is under one native unit on each leg;
 * a counterparty who needs the pair-unit strings themselves pinned must
 * compare them against the agreed ticket, not rely on the id.
 *
 * It does NOT prove the order still rests: filling a vanished order simply
 * finds nothing.
 *
 * Amounts are pair-unit integers (the market's `pair_decimals`), the same
 * strings the order carries on the wire. Only limit orders are expressible:
 * a market order's id hashes a zero expected output and, on a bid, a budget
 * these terms do not carry.
 */

import { buildOrderCommitment } from "./order-commitment.js";
import { toMarkets } from "./adapters/config-adapter.js";
import type { Configuration } from "./protos/arborter_config_pb.js";

/** The prefix, including its version, every v1 terms block starts with. */
export const TERMS_BLOCK_PREFIX = "aspens-otc:v1:";

/** The family prefix, without a version — used to name a version mismatch. */
const TERMS_BLOCK_FAMILY = "aspens-otc:";

/** Largest value a `uint64` can carry — the nonce's ceiling. */
const U64_MAX = (1n << 64n) - 1n;

/**
 * One limit order's terms, as carried in a terms block. Every amount is a
 * decimal integer string so nothing passes through a float on the way.
 */
export interface OrderTerms {
  /** `Order.market_id`, verbatim from the venue configuration. */
  market_id: string;
  side: "BID" | "ASK";
  /** Base quantity in pair units. */
  qty: string;
  /** Limit price, quote per base, in pair units. */
  price: string;
  /** `Order.nonce`, a uint64. */
  nonce: string;
  /**
   * The lock-side account, which is the order's signer: the quote-chain
   * account for a BID, the base-chain account for an ASK.
   */
  owner: string;
  /** The order id, `0x` + 64 lowercase hex digits. */
  id: string;
}

/** Outcome of {@link verifyOrderId}. */
export type OrderIdVerification =
  | { ok: true; orderId: string }
  | {
      ok: false;
      reason: string;
      /** The id the terms actually derive, when one could be derived. */
      expected?: string;
    };

const KEYS = [
  "market_id",
  "side",
  "qty",
  "price",
  "nonce",
  "owner",
  "id",
] as const;

/**
 * Recompute the order id from `terms` and the venue `config`, and compare it
 * with `terms.id` exactly.
 *
 * Chain ids come from the configuration's chains and the token decimals from
 * its market, both looked up by `terms.market_id`; the recipe is the SDK's own
 * {@link buildOrderCommitment}, the one used when placing an order. Never
 * throws: every failure, including terms the recipe refuses (an owner that is
 * not an address of the lock chain, an amount that overflows), is returned as
 * `{ ok: false, reason }`.
 */
export function verifyOrderId(
  terms: OrderTerms,
  config: Configuration,
): OrderIdVerification {
  const problem = termsProblem(terms);
  if (problem) return { ok: false, reason: problem };

  const market = toMarkets(config).find((m) => m.id === terms.market_id);
  if (!market) {
    return {
      ok: false,
      reason: `market '${terms.market_id}' is not in the venue configuration`,
    };
  }

  let expected: string;
  try {
    expected = buildOrderCommitment({
      market,
      config,
      side: terms.side === "BID" ? "buy" : "sell",
      userAddress: terms.owner,
      quantityRaw: terms.qty,
      priceRaw: terms.price,
      nonce: BigInt(terms.nonce),
    }).orderId;
  } catch (error) {
    return {
      ok: false,
      reason: `the terms cannot be hashed into an order id: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (expected !== terms.id) {
    return {
      ok: false,
      reason: "the stated id is not the id these terms derive",
      expected,
    };
  }
  return { ok: true, orderId: expected };
}

/**
 * Render `terms` as a one-line terms block. Refuses terms that
 * {@link decodeTermsBlock} would refuse, so a block this emits always decodes
 * back to the same terms.
 */
export function encodeTermsBlock(terms: OrderTerms): string {
  const problem = termsProblem(terms);
  if (problem) throw new Error(`cannot encode terms block: ${problem}`);
  // A fixed key order, so equal terms always encode to the same line.
  const ordered: Record<string, string> = {};
  for (const key of KEYS) ordered[key] = terms[key];
  return TERMS_BLOCK_PREFIX + base64UrlEncode(JSON.stringify(ordered));
}

/**
 * Parse a terms block. Surrounding whitespace is ignored; anything else that
 * is not exactly a v1 block — another prefix or version, invalid base64url,
 * JSON that is not an object, a missing, unknown or non-string field, a side
 * other than BID/ASK, an amount that is not a canonical decimal integer, a
 * nonce beyond uint64, an id that is not `0x` + 64 lowercase hex — throws.
 *
 * Decoding checks the block's FORM only. Whether the id belongs to the terms
 * is {@link verifyOrderId}'s question.
 */
export function decodeTermsBlock(block: string): OrderTerms {
  const line = block.trim();
  if (!line.startsWith(TERMS_BLOCK_PREFIX)) {
    if (line.startsWith(TERMS_BLOCK_FAMILY)) {
      throw new Error(
        `unsupported terms block version '${line.slice(TERMS_BLOCK_FAMILY.length).split(":")[0]}' (expected v1)`,
      );
    }
    throw new Error(`not a terms block: expected '${TERMS_BLOCK_PREFIX}…'`);
  }

  const json = base64UrlDecode(line.slice(TERMS_BLOCK_PREFIX.length));

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("terms block payload is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("terms block payload is not a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      throw new Error(`terms block has an unknown field '${key}'`);
    }
  }
  for (const key of KEYS) {
    if (!(key in record)) {
      throw new Error(`terms block is missing '${key}'`);
    }
    if (typeof record[key] !== "string") {
      throw new Error(`terms block field '${key}' is not a string`);
    }
  }

  const terms = record as unknown as OrderTerms;
  const problem = termsProblem(terms);
  if (problem) throw new Error(`invalid terms block: ${problem}`);
  return {
    market_id: terms.market_id,
    side: terms.side,
    qty: terms.qty,
    price: terms.price,
    nonce: terms.nonce,
    owner: terms.owner,
    id: terms.id,
  };
}

// -- internals -----------------------------------------------------------

/** A canonical non-negative decimal integer: no sign, no leading zeros. */
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const ORDER_ID = /^0x[0-9a-f]{64}$/;

/** Why `terms` is malformed, or `null` when it is well formed. */
function termsProblem(terms: OrderTerms): string | null {
  if (terms.market_id === "") return "market_id is empty";
  if (terms.side !== "BID" && terms.side !== "ASK") {
    return `side must be "BID" or "ASK", got ${JSON.stringify(terms.side)}`;
  }
  for (const key of ["qty", "price", "nonce"] as const) {
    if (!DECIMAL_INTEGER.test(terms[key])) {
      return `${key} must be a decimal integer string, got ${JSON.stringify(terms[key])}`;
    }
  }
  if (BigInt(terms.nonce) > U64_MAX) {
    return `nonce ${terms.nonce} is not a uint64`;
  }
  if (terms.owner === "") return "owner is empty";
  if (!ORDER_ID.test(terms.id)) {
    return `id must be 0x followed by 64 lowercase hex digits, got ${JSON.stringify(terms.id)}`;
  }
  return null;
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(payload: string): string {
  // Unpadded base64url only: the alphabet excludes '+', '/' and '=', and a
  // length of 1 mod 4 cannot come from any byte string.
  if (payload === "" || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error("terms block payload is not base64url");
  }
  if (payload.length % 4 === 1) {
    throw new Error("terms block payload is not base64url (truncated)");
  }
  const padded =
    payload.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (payload.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("terms block payload is not base64url");
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("terms block payload is not UTF-8");
  }
}
