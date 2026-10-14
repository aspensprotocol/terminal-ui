/**
 * Settlement evidence and account reads for the Solana midrib program.
 *
 * Events. The program emits Anchor events, which appear in a transaction's
 * logs as `Program data: <base64>`; the payload is
 * `sha256("event:<Name>")[0..8]` followed by the Borsh-encoded fields:
 *
 *   - `NetSettled { user, mint, delta: i128 }` — one per applied delta of a
 *     `settle_batch`, which covers a single mint.
 *   - `Withdrawn { account, mint, amount: u64, nonce: u64 }` — a voucher
 *     withdrawal.
 *
 * Deposits emit no event; they show only as a rise in the UserBalance
 * account's `deposited`.
 *
 * A log line says nothing about which program wrote it, so the parser tracks
 * the runtime's `Program <id> invoke [n]` / `Program <id> success|failed`
 * lines and accepts `Program data:` only while the midrib program itself is
 * the innermost running invocation. Any other program in the same
 * transaction can log bytes that look like a midrib event.
 *
 * Accounts. `UserBalance` (seeds `["balance", instance, user, mint]`) holds
 * an account's `deposited` and `locked` amounts for one mint; the
 * `TradingInstance` account holds the instance's two fee rates.
 */

import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type Finality,
  type SignaturesForAddressOptions,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";

import { deriveUserBalancePda } from "./solana-ix.js";
import type { FeeRates } from "./midrib-evm.js";

function anchorDiscriminator(namespace: string, name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${namespace}:${name}`)).slice(0, 8);
}

/** `sha256("event:NetSettled")[0..8]`. */
export const NET_SETTLED_EVENT_DISCRIMINATOR = anchorDiscriminator(
  "event",
  "NetSettled",
);
/** `sha256("event:Withdrawn")[0..8]`. */
export const WITHDRAWN_EVENT_DISCRIMINATOR = anchorDiscriminator(
  "event",
  "Withdrawn",
);
/** `sha256("account:UserBalance")[0..8]`. */
export const USER_BALANCE_ACCOUNT_DISCRIMINATOR = anchorDiscriminator(
  "account",
  "UserBalance",
);
/** `sha256("account:TradingInstance")[0..8]`. */
export const TRADING_INSTANCE_ACCOUNT_DISCRIMINATOR = anchorDiscriminator(
  "account",
  "TradingInstance",
);

/** A decoded midrib event. Pubkeys are base58. */
export type MidribSolanaEvent =
  | {
      eventName: "NetSettled";
      args: { user: string; mint: string; delta: bigint };
    }
  | {
      eventName: "Withdrawn";
      args: { account: string; mint: string; amount: bigint; nonce: bigint };
    };

// -- Byte helpers ---------------------------------------------------------

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) return false;
  }
  return true;
}

function readUintLe(data: Uint8Array, offset: number, bytes: number): bigint {
  let value = 0n;
  for (let i = bytes - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i]);
  }
  return value;
}

function readI128Le(data: Uint8Array, offset: number): bigint {
  return BigInt.asIntN(128, readUintLe(data, offset, 16));
}

function readPubkey(data: Uint8Array, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function decodeBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error("not standard base64");
  }
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// -- Events ---------------------------------------------------------------

/** Both events carry 80 bytes after the discriminator. */
const EVENT_BODY_LEN = 80;

/**
 * Decode one Anchor event payload (discriminator included). Returns `null`
 * for any discriminator other than `NetSettled` / `Withdrawn`; throws when
 * the discriminator matches but the length does not, since that means the
 * program's event layout is not the one this decoder knows.
 */
export function decodeMidribEventData(
  data: Uint8Array,
): MidribSolanaEvent | null {
  let eventName: MidribSolanaEvent["eventName"];
  if (startsWith(data, NET_SETTLED_EVENT_DISCRIMINATOR)) {
    eventName = "NetSettled";
  } else if (startsWith(data, WITHDRAWN_EVENT_DISCRIMINATOR)) {
    eventName = "Withdrawn";
  } else {
    return null;
  }
  if (data.length !== 8 + EVENT_BODY_LEN) {
    throw new Error(
      `${eventName} event is ${data.length} bytes, expected ${8 + EVENT_BODY_LEN}`,
    );
  }
  if (eventName === "NetSettled") {
    return {
      eventName,
      args: {
        user: readPubkey(data, 8),
        mint: readPubkey(data, 40),
        delta: readI128Le(data, 72),
      },
    };
  }
  return {
    eventName,
    args: {
      account: readPubkey(data, 8),
      mint: readPubkey(data, 40),
      amount: readUintLe(data, 72, 8),
      nonce: readUintLe(data, 80, 8),
    },
  };
}

export interface ParsedMidribLogs {
  /** The program's own events, in log order. */
  events: MidribSolanaEvent[];
  /**
   * The runtime cut the log short (`Log truncated`), so events after the cut
   * are missing. The transaction must be accounted for some other way.
   */
  truncated: boolean;
}

const INVOKE_RE = /^Program (\S+) invoke \[\d+\]$/;
const EXIT_RE = /^Program (\S+) (?:success$|failed)/;
const DATA_PREFIX = "Program data: ";

/**
 * Extract `programId`'s `NetSettled` / `Withdrawn` events from a
 * transaction's log messages, ignoring `Program data:` written by any other
 * program — including one the midrib program itself invoked.
 */
export function parseMidribLogs(
  logs: readonly string[],
  programId: PublicKey | string,
): ParsedMidribLogs {
  const program =
    typeof programId === "string" ? programId : programId.toBase58();
  const stack: string[] = [];
  const events: MidribSolanaEvent[] = [];
  let truncated = false;

  for (const line of logs) {
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    const exit = EXIT_RE.exec(line);
    if (exit) {
      if (stack[stack.length - 1] !== exit[1]) {
        throw new Error(
          `log exits ${exit[1]} while ${stack[stack.length - 1] ?? "nothing"} is running`,
        );
      }
      stack.pop();
      continue;
    }
    if (line === "Log truncated") {
      truncated = true;
      continue;
    }
    if (line.startsWith(DATA_PREFIX)) {
      if (stack[stack.length - 1] !== program) continue;
      const parts = line.slice(DATA_PREFIX.length).split(" ");
      // An Anchor `emit!` logs exactly one slice; the program writes no other.
      if (parts.length !== 1) continue;
      const event = decodeMidribEventData(decodeBase64(parts[0]));
      if (event) events.push(event);
    }
  }
  return { events, truncated };
}

/** A midrib event with the transaction it came from. */
export type MidribSolanaLog = MidribSolanaEvent & {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Position of the event among the program's events in that transaction. */
  eventIndex: number;
};

/** The two RPC calls the event reader makes; a web3.js `Connection` has both. */
export interface SolanaEvidenceConnection {
  getSignaturesForAddress(
    address: PublicKey,
    options?: SignaturesForAddressOptions,
    commitment?: Finality,
  ): Promise<ConfirmedSignatureInfo[]>;
  getTransaction(
    signature: string,
    config: { commitment?: Finality; maxSupportedTransactionVersion: number },
  ): Promise<{
    slot: number;
    blockTime?: number | null;
    meta: { err: unknown; logMessages?: string[] | null } | null;
  } | null>;
}

export interface ReadMidribSolanaEventsOptions {
  /** The midrib program id (the chain's `factory_address`). */
  programId: PublicKey;
  /** The trading instance (the chain's `trade_contract.address`). */
  instance: PublicKey;
  /** The account whose events to collect. */
  user: PublicKey;
  mint: PublicKey;
  /** Stop at this signature, exclusive: the newest one a previous read saw. */
  until?: string;
  /** Start below this signature, exclusive. Omit to start at the newest. */
  before?: string;
  /** Defaults to `"confirmed"`. */
  commitment?: Finality;
  /** Signatures per `getSignaturesForAddress` page (max 1000). */
  pageSize?: number;
}

export interface MidribSolanaScan {
  /** `user`'s events on `mint`, oldest first. */
  events: MidribSolanaLog[];
  /** The newest signature seen; pass it as `until` on the next read. */
  newestSignature: string | undefined;
  /**
   * Successful transactions whose logs were truncated or missing. Their
   * events may be incomplete; reconcile them against the balance account.
   */
  incomplete: string[];
}

/**
 * Collect `user`'s `NetSettled` and `Withdrawn` events on `mint` from every
 * transaction that touched its UserBalance account.
 *
 * Lists the account's signatures (newest first, paging back to `until`),
 * fetches each successful transaction, and parses only the midrib program's
 * own log lines. Failed transactions are skipped: their effects, events
 * included, were rolled back. A transaction the RPC cannot return rejects the
 * read, so the caller retries rather than advancing past it. Events for other
 * accounts in the same batch are dropped.
 */
export async function readMidribSolanaEvents(
  connection: SolanaEvidenceConnection,
  opts: ReadMidribSolanaEventsOptions,
): Promise<MidribSolanaScan> {
  const commitment = opts.commitment ?? "confirmed";
  const pageSize = opts.pageSize ?? 1000;
  const userBalance = deriveUserBalancePda(
    opts.instance,
    opts.user,
    opts.mint,
    opts.programId,
  );
  const user = opts.user.toBase58();
  const mint = opts.mint.toBase58();

  const signatures: ConfirmedSignatureInfo[] = [];
  let before = opts.before;
  for (;;) {
    const page = await connection.getSignaturesForAddress(
      userBalance,
      { before, until: opts.until, limit: pageSize },
      commitment,
    );
    signatures.push(...page);
    if (page.length < pageSize) break;
    before = page[page.length - 1].signature;
  }

  const events: MidribSolanaLog[] = [];
  const incomplete: string[] = [];
  for (const info of [...signatures].reverse()) {
    if (info.err) continue;
    const tx = await connection.getTransaction(info.signature, {
      commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      throw new Error(`transaction ${info.signature} not found`);
    }
    if (tx.meta?.err) continue;
    const logs = tx.meta?.logMessages;
    if (!logs) {
      incomplete.push(info.signature);
      continue;
    }
    const parsed = parseMidribLogs(logs, opts.programId);
    if (parsed.truncated) incomplete.push(info.signature);
    parsed.events.forEach((event, eventIndex) => {
      const who =
        event.eventName === "Withdrawn" ? event.args.account : event.args.user;
      if (who !== user || event.args.mint !== mint) return;
      events.push({
        ...event,
        signature: info.signature,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        eventIndex,
      });
    });
  }

  return {
    events,
    newestSignature: signatures[0]?.signature ?? opts.until,
    incomplete,
  };
}

// -- Accounts -------------------------------------------------------------

/** The midrib `UserBalance` account. Pubkeys are base58. */
export interface UserBalanceAccount {
  instance: string;
  user: string;
  mint: string;
  /** The balance inside the program: the counterpart of EVM `tradeBalance`. */
  deposited: bigint;
  /**
   * The on-chain lock. Order collateral is reserved off-chain by the venue,
   * so no instruction raises this; it reads 0 in practice and does not
   * reflect resting orders.
   */
  locked: bigint;
  bump: number;
}

/** 8 discriminator + 3 pubkeys + deposited + locked + bump. */
const USER_BALANCE_LEN = 8 + 32 * 3 + 8 + 8 + 1;

/** Decode a `UserBalance` account's data, discriminator included. */
export function decodeUserBalance(data: Uint8Array): UserBalanceAccount {
  if (!startsWith(data, USER_BALANCE_ACCOUNT_DISCRIMINATOR)) {
    throw new Error("not a UserBalance account (discriminator mismatch)");
  }
  if (data.length < USER_BALANCE_LEN) {
    throw new Error(
      `UserBalance account is ${data.length} bytes, expected ${USER_BALANCE_LEN}`,
    );
  }
  return {
    instance: readPubkey(data, 8),
    user: readPubkey(data, 40),
    mint: readPubkey(data, 72),
    deposited: readUintLe(data, 104, 8),
    locked: readUintLe(data, 112, 8),
    bump: data[120],
  };
}

interface AccountReader {
  getAccountInfo(
    address: PublicKey,
  ): Promise<{ data: Uint8Array; owner: PublicKey } | null>;
}

/**
 * Read `user`'s UserBalance account for `mint`, or `null` if it does not
 * exist yet (nothing was ever deposited or settled to it). Refuses an account
 * the program does not own or whose fields name a different
 * (instance, user, mint).
 */
export async function readUserBalance(
  connection: AccountReader,
  opts: {
    programId: PublicKey;
    instance: PublicKey;
    user: PublicKey;
    mint: PublicKey;
  },
): Promise<UserBalanceAccount | null> {
  const address = deriveUserBalancePda(
    opts.instance,
    opts.user,
    opts.mint,
    opts.programId,
  );
  const info = await connection.getAccountInfo(address);
  if (!info) return null;
  if (!info.owner.equals(opts.programId)) {
    throw new Error(
      `UserBalance ${address.toBase58()} is owned by ${info.owner.toBase58()}`,
    );
  }
  const balance = decodeUserBalance(info.data);
  if (
    balance.instance !== opts.instance.toBase58() ||
    balance.user !== opts.user.toBase58() ||
    balance.mint !== opts.mint.toBase58()
  ) {
    throw new Error(
      `UserBalance ${address.toBase58()} names a different instance, user or mint`,
    );
  }
  return balance;
}

/**
 * `TradingInstance` layout: discriminator(8), factory(32), signer(32),
 * maintenance_address(32), maintenance_bps u16, operator_address(32),
 * operator_bps u16, operator_admin(32), bump u8, instance_id u64.
 */
const MAINTENANCE_BPS_OFFSET = 8 + 32 * 3;
const OPERATOR_BPS_OFFSET = MAINTENANCE_BPS_OFFSET + 2 + 32;
const TRADING_INSTANCE_LEN = OPERATOR_BPS_OFFSET + 2 + 32 + 1 + 8;

/** Decode the fee rates from a `TradingInstance` account's data. */
export function decodeTradingInstanceFees(data: Uint8Array): FeeRates {
  if (!startsWith(data, TRADING_INSTANCE_ACCOUNT_DISCRIMINATOR)) {
    throw new Error("not a TradingInstance account (discriminator mismatch)");
  }
  if (data.length < TRADING_INSTANCE_LEN) {
    throw new Error(
      `TradingInstance account is ${data.length} bytes, expected ${TRADING_INSTANCE_LEN}`,
    );
  }
  return {
    maintenanceBps: Number(readUintLe(data, MAINTENANCE_BPS_OFFSET, 2)),
    operatorBps: Number(readUintLe(data, OPERATOR_BPS_OFFSET, 2)),
  };
}

/**
 * Read an instance's maintenance and operator fee rates from its
 * `TradingInstance` account. Both apply to every mint the instance settles.
 */
export async function readSolanaFeeRates(
  connection: AccountReader,
  opts: { programId: PublicKey; instance: PublicKey },
): Promise<FeeRates> {
  const info = await connection.getAccountInfo(opts.instance);
  if (!info) {
    throw new Error(`instance ${opts.instance.toBase58()} not found`);
  }
  if (!info.owner.equals(opts.programId)) {
    throw new Error(
      `instance ${opts.instance.toBase58()} is owned by ${info.owner.toBase58()}`,
    );
  }
  return decodeTradingInstanceFees(info.data);
}
