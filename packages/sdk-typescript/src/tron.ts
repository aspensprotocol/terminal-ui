/**
 * Tron primitives: the display-edge address form, the TRON message digest,
 * and hand-encoded transactions.
 *
 * A Tron account is the same 20 bytes as an Ethereum one. Inside the venue —
 * the gRPC wire, order fields, ledger keys — it is lowercase `0x` hex,
 * exactly as on EVM. The base58check `T…` form exists only where a person
 * reads or types an address: convert at that edge with {@link tronToHex} and
 * {@link hexToTron}, and never send a `T…` string to the venue.
 *
 * These are ports of the arborter's `chain-tron` crate and the Rust SDK's
 * `aspens::tron`, and share one vector fixture with them
 * (`tron-vectors.json`, captured on Nile): one byte of drift recovers a
 * different signer or a different txID, and nothing on the wire says which
 * field moved.
 */

import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { sha256 } from "@noble/hashes/sha256";
import { keccak256, type Hex } from "viem";

/** The first byte of a Tron address: `0x41` followed by the 20-byte account. */
export const TRON_ADDRESS_PREFIX = 0x41;

/**
 * How long after the reference head a transaction stays valid, in
 * milliseconds. Tron allows up to 24 hours; a short window bounds how long an
 * unseen transaction can still land.
 */
export const TRON_EXPIRATION_MS = 60_000n;

/** The prefix Tron wallets put before a message, ahead of its decimal length. */
const MESSAGE_PREFIX = "\x19TRON Signed Message:\n";

/**
 * `type.googleapis.com/` + the fully qualified message name, as every Tron
 * client writes it into `Any.type_url`.
 */
const TRIGGER_SMART_CONTRACT_TYPE_URL =
  "type.googleapis.com/protocol.TriggerSmartContract";

/** `Transaction.Contract.ContractType.TriggerSmartContract` (Tron.proto). */
const CONTRACT_TYPE_TRIGGER_SMART_CONTRACT = 31;

// -- Address edge ----------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  // Each leading zero byte is one leading '1'.
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit < 0) throw new Error(`'${text}' is not base58 ('${ch}')`);
    n = n * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

function checksum(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).slice(0, 4);
}

function toHexBody(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decode a `0x`-prefixed 20-byte hex account (any case). */
function accountBytes(account: string): Uint8Array {
  if (!account.startsWith("0x")) {
    throw new Error(`'${account}' must carry the 0x prefix`);
  }
  const body = account.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) {
    throw new Error(`'${account}' is not hex`);
  }
  if (body.length !== 40) {
    throw new Error(
      `'${account}' is ${body.length / 2} bytes, an account is 20`,
    );
  }
  return Uint8Array.from(body.match(/../g)!, (b) => parseInt(b, 16));
}

/**
 * Convert a base58check `T…` address to the venue's lowercase `0x` hex form.
 *
 * Throws unless the string is base58, decodes to 25 bytes, carries the `0x41`
 * Tron prefix, and has a valid double-SHA-256 checksum.
 */
export function tronToHex(address: string): string {
  const raw = base58Decode(address);
  if (raw.length !== 25) {
    throw new Error(
      `'${address}' decodes to ${raw.length} bytes, a Tron address is 25`,
    );
  }
  const payload = raw.slice(0, 21);
  if (payload[0] !== TRON_ADDRESS_PREFIX) {
    throw new Error(
      `'${address}' has version byte 0x${payload[0]!.toString(16).padStart(2, "0")}, a Tron address starts with 0x41`,
    );
  }
  const expected = checksum(payload);
  if (!expected.every((b, i) => b === raw[21 + i])) {
    throw new Error(`'${address}' has a bad checksum`);
  }
  return "0x" + toHexBody(payload.slice(1));
}

/**
 * Convert a `0x`-prefixed 20-byte hex account (any case) to its base58check
 * `T…` form, for display.
 */
export function hexToTron(account: string): string {
  const payload = new Uint8Array(21);
  payload[0] = TRON_ADDRESS_PREFIX;
  payload.set(accountBytes(account), 1);
  const full = new Uint8Array(25);
  full.set(payload);
  full.set(checksum(payload), 21);
  return base58Encode(full);
}

// -- TRON message signing --------------------------------------------------

/**
 * `keccak256("\x19TRON Signed Message:\n" ‖ decimal len(text) ‖ text)`, the
 * digest tronweb's `signMessageV2` signs; `len` counts the text's UTF-8
 * bytes.
 *
 * On a Tron leg the venue verifies a user signature under this digest: over
 * the lowercase hex text of the encoded `Order` / `OrderToCancel` (see
 * {@link tronMessageText}), and over a withdraw request string as is.
 */
export function tronMessageDigest(text: string): Hex {
  const prefix = new TextEncoder().encode(MESSAGE_PREFIX);
  const body = new TextEncoder().encode(text);
  const len = new TextEncoder().encode(String(body.length));
  const preimage = new Uint8Array(prefix.length + len.length + body.length);
  preimage.set(prefix, 0);
  preimage.set(len, prefix.length);
  preimage.set(body, prefix.length + len.length);
  return keccak256(preimage);
}

/**
 * The text a Tron wallet signs for an encoded protobuf message: its bytes as
 * lowercase hex, without `0x`.
 *
 * Tron wallets decode a binary message as UTF-8 lossily, so two different
 * orders could share one signed text; the hex text is one-to-one with the
 * bytes. A Tron leg never signs the binary.
 */
export function tronMessageText(encoded: Uint8Array): string {
  return toHexBody(encoded);
}

// -- Transactions ----------------------------------------------------------

/**
 * The block a transaction references (TaPoS), plus the head time its
 * expiration is counted from.
 */
export interface TronRefBlock {
  /** Bytes 6..8 of the referenced block number's 8-byte big-endian form. */
  bytes: Uint8Array;
  /** Bytes 8..16 of the referenced block's ID. */
  hash: Uint8Array;
  /** The head block's timestamp, in milliseconds. */
  headTimeMs: bigint;
}

/** One `TriggerSmartContract` call to encode. */
export interface TriggerRawDataParams {
  /** The caller's account, `0x` hex. */
  owner: string;
  /** The contract called, `0x` hex. */
  contract: string;
  /** ABI calldata. */
  data: Uint8Array | Hex;
  /** TRX sent with the call, in sun; omitted from the encoding when zero. */
  callValueSun: bigint;
  /** The most energy the call may burn, in sun. */
  feeLimitSun: bigint;
  refBlock: TronRefBlock;
  /**
   * The transaction's timestamp in milliseconds; defaults to now. The one
   * input that is not a function of the call, so a captured transaction is
   * reproduced byte for byte by passing its own.
   */
  timestampMs?: bigint;
}

function tronAddressBytes(account: string): Uint8Array {
  const out = new Uint8Array(21);
  out[0] = TRON_ADDRESS_PREFIX;
  out.set(accountBytes(account), 1);
  return out;
}

function dataBytes(data: Uint8Array | Hex): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const body = data.startsWith("0x") ? data.slice(2) : data;
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) {
    throw new Error(`calldata '${data}' is not hex`);
  }
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** A length-delimited field, omitted when empty (proto3 default). */
function putBytes(w: BinaryWriter, field: number, value: Uint8Array): void {
  if (value.length === 0) return;
  w.tag(field, WireType.LengthDelimited).bytes(value);
}

/** An `int64` field, omitted when zero (proto3 default). */
function putInt64(w: BinaryWriter, field: number, value: bigint): void {
  if (value === 0n) return;
  w.tag(field, WireType.Varint).int64(value);
}

/**
 * Encode `Transaction.raw` (Tron's `raw_data`) for one
 * `TriggerSmartContract` call, from the caller's own owner, contract and
 * calldata. `expiration` is the reference head time plus
 * {@link TRON_EXPIRATION_MS}.
 *
 * Never sign a node-built transaction instead: whatever `raw_data` a node
 * supplies is signed as the owner, so it could call anything.
 *
 * Field numbers are java-tron's `core/Tron.proto` and
 * `core/contract/smart_contract.proto`, and `google/protobuf/any.proto`.
 * Fields at their default value are omitted, as every Tron client omits
 * them: a zero `call_value` written out changes the bytes and the txID.
 */
export function buildTriggerRawData(params: TriggerRawDataParams): Uint8Array {
  const { refBlock } = params;
  if (refBlock.bytes.length !== 2) {
    throw new Error(
      `ref_block_bytes is ${refBlock.bytes.length} bytes, it must be 2 bytes`,
    );
  }
  if (refBlock.hash.length !== 8) {
    throw new Error(
      `ref_block_hash is ${refBlock.hash.length} bytes, it must be 8 bytes`,
    );
  }
  if (params.callValueSun < 0n) {
    throw new Error(`call value ${params.callValueSun} sun is negative`);
  }
  if (params.feeLimitSun < 0n) {
    throw new Error(`fee limit ${params.feeLimitSun} sun is negative`);
  }
  const timestampMs = params.timestampMs ?? BigInt(Date.now());

  // smart_contract.proto, message TriggerSmartContract:
  //   bytes owner_address = 1; bytes contract_address = 2;
  //   int64 call_value = 3;    bytes data = 4;
  const trigger = new BinaryWriter();
  putBytes(trigger, 1, tronAddressBytes(params.owner));
  putBytes(trigger, 2, tronAddressBytes(params.contract));
  putInt64(trigger, 3, params.callValueSun);
  putBytes(trigger, 4, dataBytes(params.data));

  // google/protobuf/any.proto, message Any:
  //   string type_url = 1; bytes value = 2;
  const any = new BinaryWriter();
  putBytes(any, 1, new TextEncoder().encode(TRIGGER_SMART_CONTRACT_TYPE_URL));
  putBytes(any, 2, trigger.finish());

  // Tron.proto, message Transaction.Contract:
  //   ContractType type = 1; google.protobuf.Any parameter = 2;
  const contract = new BinaryWriter();
  contract.tag(1, WireType.Varint).int32(CONTRACT_TYPE_TRIGGER_SMART_CONTRACT);
  putBytes(contract, 2, any.finish());

  // Tron.proto, message Transaction.raw:
  //   bytes ref_block_bytes = 1; bytes ref_block_hash = 4;
  //   int64 expiration = 8;      repeated Contract contract = 11;
  //   int64 timestamp = 14;      int64 fee_limit = 18;
  // Written in field-number order, as protobuf serializers do.
  const raw = new BinaryWriter();
  putBytes(raw, 1, refBlock.bytes);
  putBytes(raw, 4, refBlock.hash);
  putInt64(raw, 8, refBlock.headTimeMs + TRON_EXPIRATION_MS);
  putBytes(raw, 11, contract.finish());
  putInt64(raw, 14, timestampMs);
  putInt64(raw, 18, params.feeLimitSun);
  return raw.finish();
}

/**
 * The transaction ID, `sha256(raw_data)`, as Tron writes it: 64 lowercase
 * hex characters without `0x`. It is also the digest the owner signs.
 */
export function tronTxId(rawData: Uint8Array): string {
  return toHexBody(sha256(rawData));
}

/**
 * The `/jsonrpc` URL under a Tron node's HTTP base (a Tron chain's
 * configured RPC URL), where the EVM read code points. A query string — where
 * a provider's API key goes — is kept. A url already ending in `/jsonrpc` is
 * returned as is, so an override given in either form works.
 */
export function tronJsonRpcUrl(base: string): string {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/jsonrpc") ? path : path + "/jsonrpc";
  return url.toString();
}
