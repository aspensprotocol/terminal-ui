/**
 * Native Tron transactions from a user wallet, over a Tron node's HTTP API.
 *
 * A Tron chain's configured RPC URL is the node's HTTP base
 * (`https://api.trongrid.io`). Reads go through `<base>/jsonrpc` with the
 * EVM code (`publicClientFor`, `tronPublicClient`); what Tron's JSON-RPC
 * cannot do goes to the native routes under the same base:
 *
 * - `/walletsolidity/getnowblock`: the solidified block a new transaction
 *   references (a head block can be reorged away, stranding the transaction
 *   until it expires);
 * - `/wallet/getnowblock`: the head, whose time the expiration counts from
 *   and against which an unseen transaction is judged expired;
 * - `/wallet/triggerconstantcontract`: the exact call, simulated before it
 *   is signed;
 * - `/wallet/broadcasthex`: Tron has no `eth_sendRawTransaction`;
 * - `/wallet/gettransactioninfobyid`: the receipt, whose `receipt.result`
 *   says whether the call did anything.
 *
 * {@link sendTronTx} is the one way this SDK sends a Tron transaction. The
 * transaction is encoded here from the caller's own contract and calldata
 * and signed once; a node-built transaction is never signed. It resolves only
 * when the receipt says `SUCCESS`; every other outcome throws a
 * {@link TronTxError}. That is enough for a user's own transaction: the venue
 * credits a deposit only once the chain finalizes it, so a reorged deposit is
 * simply never credited.
 *
 * Every call uses plain `fetch`. A node is a list of HTTP bases tried in
 * order (the next one is tried when one does not answer), plus an optional
 * TronGrid API key sent as the `TRON-PRO-API-KEY` header.
 */

import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  createPublicClient,
  fallback,
  http,
  recoverAddress,
  type Hex,
  type PublicClient,
} from "viem";

import type { SigningAdapter } from "./signing.js";
import {
  buildTriggerRawData,
  TRON_ADDRESS_PREFIX,
  TRON_EXPIRATION_MS,
  tronJsonRpcUrl,
  tronTxId,
} from "./tron.js";

/**
 * Tron's block interval. A transaction still unseen once the head is a block
 * past its expiration can no longer be included.
 */
export const TRON_BLOCK_INTERVAL_MS = 3_000n;

/** A Tron node as this SDK reaches it. */
export interface TronNode {
  /**
   * HTTP bases (a Tron chain's configured RPC URL, e.g.
   * `https://nile.trongrid.io`), tried in order: the next is used only when
   * one does not answer. A query string is kept on every derived path.
   */
  urls: string[];
  /** Sent as the `TRON-PRO-API-KEY` header when set (TronGrid). */
  apiKey?: string;
  /**
   * How long one HTTP request may take before it is abandoned as
   * unanswered, in milliseconds; default {@link TRON_REQUEST_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/**
 * The default limit on one Tron HTTP request (connect, send and read). A
 * request still pending then is aborted and counts as unanswered, so a
 * stalled connection cannot hold a send past its expiry check.
 */
export const TRON_REQUEST_TIMEOUT_MS = 30_000;

/** A block's number, ID and timestamp, from either `getnowblock`. */
export interface TronBlockHeader {
  number: bigint;
  /** The 32-byte block ID; its first 8 bytes are the number (checked). */
  id: Uint8Array;
  /** The block's timestamp, in milliseconds. */
  timeMs: bigint;
}

/** A transaction's execution record (`gettransactioninfobyid`). */
export interface TronTxInfo {
  /** The txID the record is for: 64 lowercase hex characters, no `0x`. */
  id: string;
  /** The block that includes it. */
  blockNumber: bigint;
  /** `receipt.result === "SUCCESS"`, and nothing else. */
  success: boolean;
  /**
   * Why it failed: the receipt result, the node's message and any revert
   * data. Absent on success.
   */
  failure?: string;
}

/** What a broadcast came back with. */
export type TronBroadcastResult =
  /** The node took it, or already held it. */
  | { kind: "accepted" }
  /** The node judged it and refused it; the same bytes get the same answer. */
  | { kind: "rejected"; code: string; message: string }
  /**
   * Nobody answered, or the node was busy: whether it was received is
   * unknown, and the identical bytes are safe to send again.
   */
  | { kind: "unanswered"; reason: string };

/** A transaction whose receipt says `SUCCESS`. */
export interface TronReceipt {
  /** `sha256(raw_data)`: 64 lowercase hex characters, no `0x`. */
  txId: string;
  /** The block that includes it. */
  blockNumber: bigint;
}

/**
 * Why {@link sendTronTx} did not succeed.
 *
 * `sent` is false when nothing was broadcast (the simulation refused the
 * call, the node could not be read, or the wallet would not sign, or signed
 * as another account): trying again is free. When `sent` is true the transaction was
 * signed and may have reached a node, and the message names its `txId` and
 * what is known of its fate.
 */
export class TronTxError extends Error {
  readonly sent: boolean;
  readonly txId?: string;

  constructor(message: string, sent: boolean, txId?: string) {
    super(sent ? message : `${message}; nothing was broadcast`);
    this.name = "TronTxError";
    this.sent = sent;
    this.txId = txId;
  }
}

// -- HTTP ------------------------------------------------------------------

/** `base` with `suffix` appended to its path, keeping any query string. */
function joinPath(base: string, suffix: string): string {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/+$/, "") + suffix;
  return url.toString();
}

/** A base url safe to print: scheme, host and path, never a query or userinfo. */
function redact(base: string): string {
  try {
    const url = new URL(base);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "<unparseable url>";
  }
}

function headers(node: TronNode): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  if (node.apiKey) out["TRON-PRO-API-KEY"] = node.apiKey;
  return out;
}

type Posted =
  | { kind: "answered"; json: Record<string, unknown>; base: string }
  | { kind: "unanswered"; reason: string }
  /** A node refused the request itself (HTTP 4xx); resending it is futile. */
  | { kind: "refused"; status: number; reason: string };

/** A 4xx a node returns for a request it will never accept. 403 and 429 are rate limits. */
function isClientError(status: number): boolean {
  return status >= 400 && status < 500 && status !== 403 && status !== 429;
}

/**
 * POST `body` (already JSON text) to `path` on the first of `node.urls` that
 * answers.
 *
 * A fetch that throws or exceeds the node's timeout, a 5xx, a 403 or 429
 * rate limit, or a body that is not a JSON object counts as no answer, and
 * the next url is tried. A 4xx other than those is the request's own fault,
 * but it speaks only for the node that returned it: the result is `refused`
 * only when EVERY url returned such a status. If any url failed in a way
 * that may have let the request through (a timeout, a dropped connection, a
 * 5xx, a rate limit), the result is `unanswered`, because for a broadcast
 * that node may have taken the transaction.
 */
async function postRaw(
  node: TronNode,
  path: string,
  body: string,
): Promise<Posted> {
  if (node.urls.length === 0) {
    return { kind: "unanswered", reason: `${path}: no Tron node url` };
  }
  const reasons: string[] = [];
  let refused: { status: number; reason: string } | null = null;
  let refusals = 0;
  const timeoutMs = node.timeoutMs ?? TRON_REQUEST_TIMEOUT_MS;
  for (const base of node.urls) {
    const where = `${path} at ${redact(base)}`;
    let response: Response;
    try {
      response = await fetch(joinPath(base, path), {
        method: "POST",
        headers: headers(node),
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      reasons.push(`${where}: request failed (${errText(err)})`);
      continue;
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 200);
      } catch {
        // The status alone says enough.
      }
      const reason = `${where}: HTTP ${response.status}${detail ? ` (${detail})` : ""}`;
      reasons.push(reason);
      if (isClientError(response.status)) {
        refusals++;
        refused ??= { status: response.status, reason };
      }
      continue;
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      reasons.push(`${where}: the answer is not JSON`);
      continue;
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      reasons.push(`${where}: the answer is not a JSON object`);
      continue;
    }
    return { kind: "answered", json: json as Record<string, unknown>, base };
  }
  if (refused && refusals === node.urls.length) {
    return { kind: "refused", status: refused.status, reason: refused.reason };
  }
  return { kind: "unanswered", reason: reasons.join("; ") };
}

/**
 * {@link postRaw} for a read: no answer, a refusal, or a node `Error`
 * throws. Returns the answer and the base url that gave it.
 */
async function postFrom(
  node: TronNode,
  path: string,
  body: string,
): Promise<{ json: Record<string, unknown>; base: string }> {
  const posted = await postRaw(node, path, body);
  if (posted.kind !== "answered") throw new Error(posted.reason);
  const error = posted.json["Error"];
  if (typeof error === "string") {
    throw new Error(`${path}: node error: ${error}`);
  }
  return { json: posted.json, base: posted.base };
}

async function post(
  node: TronNode,
  path: string,
  body: string,
): Promise<Record<string, unknown>> {
  return (await postFrom(node, path, body)).json;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hexBody(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(hex: string): Uint8Array | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(body)) return null;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** `41` ‖ the 20-byte account, as the HTTP API takes it with `visible: false`. */
function tronAddressHex(account: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) {
    throw new Error(
      `'${account}' is not a 0x-hex 20-byte account (convert a T-address with tronToHex)`,
    );
  }
  return TRON_ADDRESS_PREFIX.toString(16) + account.slice(2).toLowerCase();
}

/**
 * Tron sends `message` / `resMessage` as hex-encoded UTF-8; fall back to the
 * raw value when it is not.
 */
function hexText(value: unknown): string {
  if (typeof value !== "string") return "";
  const bytes = bytesFromHex(value);
  if (!bytes || bytes.length === 0) return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

function asNonNegativeInteger(value: unknown): bigint | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : null;
}

// -- Node calls ------------------------------------------------------------

function parseBlock(
  block: Record<string, unknown>,
  call: string,
): TronBlockHeader {
  const id =
    typeof block["blockID"] === "string"
      ? bytesFromHex(block["blockID"])
      : null;
  if (!id || id.length !== 32) throw new Error(`${call}: no 32-byte blockID`);
  const header = (
    block["block_header"] as Record<string, unknown> | undefined
  )?.["raw_data"] as Record<string, unknown> | undefined;
  if (!header) throw new Error(`${call}: no block_header.raw_data`);
  const number = asNonNegativeInteger(header["number"]);
  if (number === null) throw new Error(`${call}: no block number`);
  const timeMs = asNonNegativeInteger(header["timestamp"]);
  if (timeMs === null) throw new Error(`${call}: no block timestamp`);
  let prefix = 0n;
  for (const b of id.slice(0, 8)) prefix = (prefix << 8n) | BigInt(b);
  if (prefix !== number) {
    throw new Error(
      `${call}: blockID ${hexBody(id)} does not belong to block number ${number}`,
    );
  }
  return { number, id, timeMs };
}

/**
 * The node's current block: the head (`/wallet/getnowblock`), or with
 * `solidified` the latest solidified block (`/walletsolidity/getnowblock`).
 */
export async function nowBlock(
  node: TronNode,
  opts: { solidified?: boolean } = {},
): Promise<TronBlockHeader> {
  return (await nowBlockFrom(node, opts)).header;
}

/** {@link nowBlock}, with the base url that answered. */
async function nowBlockFrom(
  node: TronNode,
  opts: { solidified?: boolean } = {},
): Promise<{ header: TronBlockHeader; base: string }> {
  const path = opts.solidified
    ? "/walletsolidity/getnowblock"
    : "/wallet/getnowblock";
  const { json, base } = await postFrom(node, path, "{}");
  return { header: parseBlock(json, path), base };
}

/**
 * Whether a `triggerconstantcontract` answer reports a successful execution.
 * `result.result` only says the node took the request; the outcome is the
 * returned transaction's `ret`, whose success is the omitted default.
 */
function simulationFailure(resp: Record<string, unknown>): string | null {
  const result = resp["result"] as Record<string, unknown> | undefined;
  if (result?.["result"] !== true) {
    const code =
      typeof result?.["code"] === "string" ? result["code"] : "no result";
    return `refused: ${code}: ${hexText(result?.["message"])}`;
  }
  const tx = resp["transaction"] as Record<string, unknown> | undefined;
  const rets = tx?.["ret"];
  const ret =
    Array.isArray(rets) && typeof rets[0] === "object" && rets[0] !== null
      ? (rets[0] as Record<string, unknown>)
      : null;
  if (!ret) return "the answer carries no execution result";
  const code = ret["ret"];
  const contractRet = ret["contractRet"];
  // java-tron spells the success code "SUCESS".
  const codeOk = code === undefined || code === "SUCESS" || code === "SUCCESS";
  const contractOk = contractRet === undefined || contractRet === "SUCCESS";
  if (!codeOk || !contractOk) {
    const what =
      typeof contractRet === "string"
        ? contractRet
        : typeof code === "string"
          ? code
          : "unknown";
    return `did not succeed (${what}): ${hexText(result["message"])}`;
  }
  return null;
}

/** One call, as it is simulated and then sent. */
export interface TronCall {
  /** The caller's account, `0x` hex. */
  owner: string;
  /** The contract called, `0x` hex. */
  contract: string;
  /** ABI calldata. */
  data: Hex;
  /** TRX sent with the call, in sun. */
  callValueSun: bigint;
}

/**
 * Run `call` as its owner against the head state, signing and sending
 * nothing (`/wallet/triggerconstantcontract`). Resolves only when it
 * executed successfully; otherwise throws with the reason and any revert
 * data.
 */
export async function simulateTronCall(
  node: TronNode,
  call: TronCall,
): Promise<void> {
  const data = bytesFromHex(call.data);
  if (!data) throw new Error(`calldata '${call.data}' is not hex`);
  if (call.callValueSun < 0n) {
    throw new Error(`call value ${call.callValueSun} sun is negative`);
  }
  let body = JSON.stringify({
    owner_address: tronAddressHex(call.owner),
    contract_address: tronAddressHex(call.contract),
    data: hexBody(data),
    visible: false,
  });
  // Written as a JSON integer literal by hand: JSON.stringify has no bigint,
  // and a Number would round a value past 2^53.
  if (call.callValueSun !== 0n) {
    body = body.slice(0, -1) + `,"call_value":${call.callValueSun}}`;
  }
  const resp = await post(node, "/wallet/triggerconstantcontract", body);
  const failure = simulationFailure(resp);
  if (failure) {
    const constant = resp["constant_result"];
    const revert =
      Array.isArray(constant) &&
      typeof constant[0] === "string" &&
      constant[0] !== ""
        ? ` (revert data 0x${constant[0]})`
        : "";
    throw new Error(
      `simulated call to ${call.contract} as ${call.owner}: ${failure}${revert}`,
    );
  }
}

/**
 * Broadcast a signed transaction (`/wallet/broadcasthex`). A node that
 * already holds it (`DUP_TRANSACTION_ERROR`) counts as accepted; a busy or
 * unreachable node is `unanswered`, never `rejected`.
 */
export async function broadcastHex(
  node: TronNode,
  signedHex: string,
): Promise<TronBroadcastResult> {
  const posted = await postRaw(
    node,
    "/wallet/broadcasthex",
    JSON.stringify({ transaction: signedHex }),
  );
  if (posted.kind === "unanswered") {
    return { kind: "unanswered", reason: posted.reason };
  }
  if (posted.kind === "refused") {
    return {
      kind: "rejected",
      code: `HTTP ${posted.status}`,
      message: posted.reason,
    };
  }
  const resp = posted.json;
  if (resp["result"] === true) return { kind: "accepted" };
  const code = resp["code"];
  if (typeof code !== "string") {
    const error = typeof resp["Error"] === "string" ? resp["Error"] : "";
    return {
      kind: "unanswered",
      reason: `broadcasthex: no result: ${error || "unrecognised response"}`,
    };
  }
  const message = hexText(resp["message"]);
  switch (code) {
    case "DUP_TRANSACTION_ERROR":
      return { kind: "accepted" };
    case "SERVER_BUSY":
    case "NO_CONNECTION":
    case "NOT_ENOUGH_EFFECTIVE_CONNECTION":
      return {
        kind: "unanswered",
        reason: `broadcasthex: ${code}: ${message}`,
      };
    default:
      return { kind: "rejected", code, message };
  }
}

/**
 * The execution record of `txId` (`/wallet/gettransactioninfobyid`), or
 * `null` while no block includes it. Throws when the node cannot be read or
 * answers for another transaction.
 */
export async function txInfo(
  node: TronNode,
  txId: string,
): Promise<TronTxInfo | null> {
  const id = (txId.startsWith("0x") ? txId.slice(2) : txId).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new Error(`txID ${txId} is not 32 bytes of hex`);
  }
  const resp = await post(
    node,
    "/wallet/gettransactioninfobyid",
    JSON.stringify({ value: id }),
  );
  if (Object.keys(resp).length === 0) return null;
  if (resp["id"] !== id) {
    throw new Error(
      `gettransactioninfobyid ${id}: the node answered for ${JSON.stringify(resp["id"])}`,
    );
  }
  const blockNumber = asNonNegativeInteger(resp["blockNumber"]);
  if (blockNumber === null) {
    throw new Error(`gettransactioninfobyid ${id}: no blockNumber`);
  }
  const receipt = resp["receipt"] as Record<string, unknown> | undefined;
  const result = receipt?.["result"];
  const success = result === "SUCCESS";
  if (success) return { id, blockNumber, success };
  let failure = typeof result === "string" ? result : "no receipt result";
  const message = hexText(resp["resMessage"]);
  if (message) failure += `: ${message}`;
  const contractResult = resp["contractResult"];
  if (
    Array.isArray(contractResult) &&
    typeof contractResult[0] === "string" &&
    contractResult[0] !== ""
  ) {
    failure += ` (revert data 0x${contractResult[0]})`;
  }
  return { id, blockNumber, success, failure };
}

/**
 * A viem public client for a Tron node's `/jsonrpc`, with the node's
 * failover order and API key: the EVM read code (`readTradeBalance`,
 * `readEvmFeeRates`, `readMidribEvents`, `readEvmWalletBalance`, an ERC-20
 * allowance) runs against it unchanged.
 */
export function tronPublicClient(node: TronNode): PublicClient {
  if (node.urls.length === 0) throw new Error("no Tron node url");
  const fetchOptions = node.apiKey
    ? { headers: { "TRON-PRO-API-KEY": node.apiKey } }
    : undefined;
  const transports = node.urls.map((u) =>
    http(tronJsonRpcUrl(u), { fetchOptions }),
  );
  return createPublicClient({
    transport: transports.length === 1 ? transports[0]! : fallback(transports),
  }) as PublicClient;
}

// -- Sending ---------------------------------------------------------------

/** One `TriggerSmartContract` call to send. */
export interface SendTronTxParams extends TronCall {
  node: TronNode;
  /** Signs the txID; must implement `signTronTransaction`. */
  adapter: SigningAdapter;
  /** The most energy the call may burn, in sun. */
  feeLimitSun: bigint;
  /** Between two looks at the transaction; default 1 s. */
  pollIntervalMs?: number;
  /**
   * A backstop on the whole wait, for a node whose head stops advancing;
   * default 5 minutes. Reaching it throws.
   */
  giveUpAfterMs?: number;
}

/** `Transaction { raw raw_data = 1; repeated bytes signature = 2; }`, as hex. */
function signedTxHex(raw: Uint8Array, signature: Uint8Array): string {
  const w = new BinaryWriter();
  w.tag(1, WireType.LengthDelimited).bytes(raw);
  w.tag(2, WireType.LengthDelimited).bytes(signature);
  return hexBody(w.finish());
}

/**
 * Said of a failed receipt: it was read at the head, where a block can still
 * be reorged out and the same signed bytes re-included before they expire, so
 * the failure is not final.
 */
const AT_HEAD =
  "That block is not yet solidified, so this is not final: check the txID " +
  "once it is solidified before retrying";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Build, sign, broadcast and confirm one `TriggerSmartContract` call from
 * `owner` to `contract`.
 *
 * - The exact call is simulated first. A call that would revert throws and
 *   nothing is signed or broadcast.
 * - The transaction references the solidified block and expires
 *   {@link TRON_EXPIRATION_MS} after the head. The adapter is asked to sign
 *   it once, and the signature must recover to `owner`.
 * - A broadcast nobody answered is sent again as the identical hex, never
 *   re-signed: Tron has no nonce, so a re-signed transaction (a new
 *   timestamp, so a new txID) could land beside the first.
 * - Resolves only for a receipt whose `receipt.result` is `SUCCESS`. Any
 *   other receipt throws with the txID and the reason; OUT_OF_ENERGY and a
 *   broadcast refused for the account's resources name the account. A
 *   failed receipt is read at the head, so its message says the failure is
 *   not final yet rather than that the transaction had no effect.
 * - Unseen once the head is a block past the expiration throws, as
 *   UNCONFIRMED: the node that judged the expiry also gave the last look,
 *   and the message says to check before retrying rather than claiming the
 *   transaction had no effect.
 * - Every HTTP request is abandoned after the node's timeout and counts as
 *   unanswered, so a stalled connection cannot hold the wait open. A 4xx
 *   (other than a 403 / 429 rate limit) on the broadcast is a refusal only
 *   when every url returned one. A refusal after an unanswered broadcast,
 *   like an unseen expiry or the backstop, is UNCONFIRMED.
 */
export async function sendTronTx(
  params: SendTronTxParams,
): Promise<TronReceipt> {
  const { node, adapter, owner, contract, data, callValueSun, feeLimitSun } =
    params;
  const pollIntervalMs = params.pollIntervalMs ?? 1_000;
  const giveUpAfterMs = params.giveUpAfterMs ?? 300_000;
  const notSent = (message: string) => new TronTxError(message, false);

  if (!adapter.signTronTransaction) {
    throw notSent("the signing adapter cannot sign a Tron transaction");
  }

  // The very call about to be signed, run first: one that would revert is
  // never sent, since it would burn its energy and change nothing.
  try {
    await simulateTronCall(node, { owner, contract, data, callValueSun });
  } catch (err) {
    throw notSent(errText(err));
  }

  let raw: Uint8Array;
  let expirationMs: bigint;
  try {
    const solid = await nowBlock(node, { solidified: true });
    const head = await nowBlock(node);
    const numberBytes = new Uint8Array(8);
    new DataView(numberBytes.buffer).setBigUint64(0, solid.number);
    raw = buildTriggerRawData({
      owner,
      contract,
      data,
      callValueSun,
      feeLimitSun,
      refBlock: {
        bytes: numberBytes.slice(6, 8),
        hash: solid.id.slice(8, 16),
        headTimeMs: head.timeMs,
      },
    });
    expirationMs = head.timeMs + TRON_EXPIRATION_MS;
  } catch (err) {
    throw notSent(errText(err));
  }
  const id = tronTxId(raw);

  // The only signature this transaction gets.
  let signature: Uint8Array;
  try {
    const signed = await adapter.signTronTransaction(id, hexBody(raw));
    const bytes = bytesFromHex(signed);
    if (!bytes || bytes.length !== 65) {
      throw new Error(`the wallet's signature is not 65 bytes: ${signed}`);
    }
    const signer = await recoverAddress({
      hash: `0x${id}`,
      signature: `0x${hexBody(bytes)}`,
    });
    if (signer.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `the wallet signed as ${signer.toLowerCase()}, not as ${owner.toLowerCase()}`,
      );
    }
    signature = bytes;
  } catch (err) {
    throw notSent(`tron transaction ${id}: ${errText(err)}`);
  }
  const signedHex = signedTxHex(raw, signature);

  const sent = (message: string) => new TronTxError(message, true, id);
  const judge = (info: TronTxInfo): TronReceipt => {
    if (info.success) return { txId: id, blockNumber: info.blockNumber };
    const reason = info.failure ?? "no receipt result";
    if (reason.startsWith("OUT_OF_ENERGY")) {
      throw sent(
        `tron transaction ${id} ran out of energy in block ${info.blockNumber}: ` +
          `${reason}. Energy is paid by burning ${owner.toLowerCase()}'s TRX up ` +
          `to the fee limit: fund that account. ${AT_HEAD}`,
      );
    }
    throw sent(
      `tron transaction ${id} FAILED at the head, in block ${info.blockNumber}: ` +
        `${reason}. ${AT_HEAD}`,
    );
  };

  const started = Date.now();
  let accepted = false;
  let unanswered = false;
  for (;;) {
    if (!accepted) {
      const result = await broadcastHex(node, signedHex);
      switch (result.kind) {
        case "accepted":
          accepted = true;
          break;
        case "rejected":
          throw sent(
            rejection(id, owner, result.code, result.message, unanswered),
          );
        case "unanswered":
          // Received or not, nobody said: the same bytes go out again.
          unanswered = true;
          break;
      }
    }

    // Looked for whether or not the broadcast was acknowledged: an
    // unanswered one may still have reached a node.
    let info: TronTxInfo | null = null;
    try {
      info = await txInfo(node, id);
    } catch {
      // A failed receipt read is retried on the next pass.
    }
    if (info) return judge(info);

    let headAt: { header: TronBlockHeader; base: string } | null = null;
    try {
      headAt = await nowBlockFrom(node);
    } catch {
      // An unreadable head cannot prove expiry; the backstop below still ends the wait.
    }
    if (
      headAt &&
      headAt.header.timeMs > expirationMs + TRON_BLOCK_INTERVAL_MS
    ) {
      const { header: head, base } = headAt;
      // One last look, asked of the very node whose head is past the
      // expiration, so a lagging node's "unseen" is never judged against
      // another node's head. It may also have landed since the read above.
      let last: TronTxInfo | null;
      try {
        last = await txInfo({ ...node, urls: [base] }, id);
      } catch (err) {
        throw sent(
          `tron transaction ${id} is UNCONFIRMED: past its expiration, and its ` +
            `receipt cannot be read (${errText(err)}); whether it landed is ` +
            `unknown, so check it before retrying`,
        );
      }
      if (last) return judge(last);
      // Unseen by that node is not proof it never landed elsewhere: the
      // outcome is unknown, and a retry could do the same thing twice.
      throw sent(
        `tron transaction ${id} is UNCONFIRMED: not seen before expiry by ` +
          `${redact(base)} (its head, block ${head.number} at ${head.timeMs} ms, ` +
          `is past the expiration ${expirationMs} ms plus a block); check the ` +
          `txID or the account before retrying`,
      );
    }

    if (Date.now() - started >= giveUpAfterMs) {
      throw sent(
        `tron transaction ${id} is UNCONFIRMED: no receipt after ` +
          `${giveUpAfterMs} ms and its expiration could not be judged; whether ` +
          `it landed is unknown, so check it before retrying`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

function rejection(
  id: string,
  owner: string,
  code: string,
  message: string,
  earlierUnanswered: boolean,
): string {
  if (earlierUnanswered) {
    // The same bytes went out before and nobody said whether they were
    // taken: this refusal does not prove the transaction never lands.
    return (
      `tron transaction ${id} is UNCONFIRMED: a node refused it (${code}: ` +
      `${message}), but an earlier broadcast of it went unanswered, so it may ` +
      `still land before it expires; check the txID or the account ` +
      `${owner.toLowerCase()} before retrying`
    );
  }
  const lower = message.toLowerCase();
  const funding =
    code === "BANDWITH_ERROR" ||
    (code === "CONTRACT_VALIDATE_ERROR" &&
      (lower.includes("balance") ||
        lower.includes("owneraccount") ||
        lower.includes("insufficient")));
  if (funding) {
    return (
      `tron node refused transaction ${id}: ${code}: ${message}. The account ` +
      `${owner.toLowerCase()} cannot pay for it: fund it with TRX`
    );
  }
  return `tron node refused transaction ${id}: ${code}: ${message}`;
}
