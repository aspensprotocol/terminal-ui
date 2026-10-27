/**
 * Tron writes against a mocked node: `sendTronTx` and the MidribV3 calls
 * built on it.
 *
 * Every HTTP path is served by a stubbed `fetch` that records what was
 * asked. The rule under test is that user funds only ever move through a
 * transaction whose receipt says SUCCESS: every other outcome, including one
 * the node never reports, must reject.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { sha256 } from "@noble/hashes/sha256";
import { decodeFunctionData, recoverAddress, type Hex } from "viem";

import { MIDRIB_V3_ABI, ERC20_APPROVAL_ABI } from "./midrib-evm.js";
import { privateKeyTronAdapter, type SigningAdapter } from "./signing.js";
import {
  sendTronTx,
  TronTxError,
  type SendTronTxParams,
  type TronNode,
} from "./tron-client.js";
import {
  assertTronWithdrawTrx,
  TRON_MIN_TRX_FOR_WITHDRAW_SUN,
  TRON_APPROVE_FEE_LIMIT_SUN,
  TRON_DEPOSIT_FEE_LIMIT_SUN,
  TRON_DEPOSIT_NATIVE_FEE_LIMIT_SUN,
  TRON_WITHDRAW_FEE_LIMIT_SUN,
  tronDeposit,
  tronDepositNative,
  tronWithdraw,
} from "./midrib-tron.js";
import vectors from "./tron-vectors.json";

// -- Fixture values --------------------------------------------------------

const KEY = vectors.test_only_private_key.private_key as Hex;
const OWNER = vectors.test_only_private_key.address_hex; // 0xa541…e646
const INSTANCE = "0xc76d503a0aecd5115aa23639fe90e2de7ad63719";
const USDT = "0xeca9bc828a3005b9a3b909f2cc5c2a54794de05f";
const BASE = "https://nile.example/node";

const SOLID_NUMBER = 72_052_479;
const HEAD_TIME = 1_792_691_274_000;
const EXPIRY_PLUS_BLOCK = HEAD_TIME + 60_000 + 3_000;

const hexOf = (s: string) => Buffer.from(s, "utf8").toString("hex");

function block(number: number, timeMs: number) {
  return {
    blockID: number.toString(16).padStart(16, "0") + "cd".repeat(24),
    block_header: { raw_data: { number, timestamp: timeMs } },
  };
}

// -- Mock node -------------------------------------------------------------

interface Seen {
  url: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** An answer: JSON (status 200), a raw Response, or a thrown transport error. */
type Answer = unknown | Response | { throw: string };
type Route = (body: Record<string, unknown>, nth: number) => Answer;

let seen: Seen[] = [];
let routes: Record<string, Route> = {};
/** Per-host routes, consulted before `routes` (for multi-node tests). */
let hostRoutes: Record<string, Record<string, Route>> = {};
/** Answer with this to never answer: the request settles only by its abort. */
const HANG = { hang: true };
const realFetch = globalThis.fetch;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch() {
  const counts: Record<string, number> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const u = new URL(url);
    const path = u.pathname.replace(/^\/node/, "");
    const hdrs: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (hdrs[k.toLowerCase()] = v));
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ url, path, headers: hdrs, body });
    if (u.host === "down.example") throw new TypeError("connect failed");
    const nth = (counts[url] = (counts[url] ?? 0) + 1) - 1;
    const route = hostRoutes[u.host]?.[path] ?? routes[path];
    if (!route) throw new Error(`unmocked ${path}`);
    const answer = route(body, nth);
    if (answer === HANG) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason ?? new Error("aborted")),
        );
      });
    }
    if (answer instanceof Response) return answer;
    if (answer && typeof answer === "object" && "throw" in answer) {
      throw new TypeError((answer as { throw: string }).throw);
    }
    return json(answer);
  }) as typeof fetch;
}

/** A receipt route: `{}` for the first `unseen` asks, then `result`. */
function receipts(result: string | null, unseen = 0): Route {
  return (body, nth) => {
    if (nth < unseen) return {};
    const record: Record<string, unknown> = {
      id: body["value"],
      blockNumber: SOLID_NUMBER + 21,
      blockTimeStamp: HEAD_TIME + 3_000,
      contractResult: [""],
      receipt: { energy_usage_total: 32_798 },
    };
    if (result !== null) {
      (record["receipt"] as Record<string, unknown>)["result"] = result;
    }
    if (result !== "SUCCESS") {
      record["result"] = "FAILED";
      record["resMessage"] = hexOf("REVERT opcode executed");
      record["contractResult"] = ["90b8ec18"];
    }
    return record;
  };
}

function defaultRoutes(): Record<string, Route> {
  return {
    "/wallet/triggerconstantcontract": () => ({
      result: { result: true },
      constant_result: [""],
      transaction: { ret: [{}] },
      energy_used: 32_798,
    }),
    "/walletsolidity/getnowblock": () =>
      block(SOLID_NUMBER, HEAD_TIME - 57_000),
    "/wallet/getnowblock": () => block(SOLID_NUMBER + 19, HEAD_TIME),
    "/wallet/broadcasthex": () => ({ result: true }),
    "/wallet/gettransactioninfobyid": () => ({}),
  };
}

/** A fresh node: default routes, nothing seen, answer counts at zero. */
function reset() {
  seen = [];
  hostRoutes = {};
  routes = defaultRoutes();
  installFetch();
}

beforeEach(reset);

afterEach(() => {
  globalThis.fetch = realFetch;
});

const at = (path: string) => seen.filter((s) => s.path === path);
const broadcasts = () =>
  at("/wallet/broadcasthex").map((s) => s.body["transaction"] as string);

/** The fixture key's adapter, counting signatures. */
function countingAdapter(): SigningAdapter & { signed: string[] } {
  const inner = privateKeyTronAdapter(KEY);
  const signed: string[] = [];
  return {
    signed,
    signMessage: inner.signMessage,
    signTronMessage: inner.signTronMessage,
    async signTronTransaction(txId, rawDataHex) {
      signed.push(txId);
      return inner.signTronTransaction!(txId, rawDataHex);
    },
  };
}

const NODE: TronNode = { urls: [BASE] };
const DATA: Hex = "0xe0a273bc010203";

function params(
  adapter: SigningAdapter,
  over: Partial<SendTronTxParams> = {},
): SendTronTxParams {
  return {
    node: NODE,
    adapter,
    owner: OWNER,
    contract: INSTANCE,
    data: DATA,
    callValueSun: 0n,
    feeLimitSun: TRON_WITHDRAW_FEE_LIMIT_SUN,
    pollIntervalMs: 1,
    giveUpAfterMs: 2_000,
    ...over,
  };
}

// -- Decoding what was broadcast -------------------------------------------

type Field = bigint | Uint8Array;

function fields(buf: Uint8Array): Map<number, Field[]> {
  const r = new BinaryReader(buf);
  const out = new Map<number, Field[]>();
  while (r.pos < r.len) {
    const [no, wt] = r.tag();
    const v: Field = wt === 0 ? BigInt(r.uint64()) : r.bytes();
    out.set(no, [...(out.get(no) ?? []), v]);
  }
  return out;
}

const one = (m: Map<number, Field[]>, n: number) => m.get(n)?.[0];
const bytesAt = (m: Map<number, Field[]>, n: number) => one(m, n) as Uint8Array;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function decodeSent(txHex: string) {
  const tx = fields(Buffer.from(txHex, "hex"));
  const raw = bytesAt(tx, 1);
  const signature = bytesAt(tx, 2);
  const rawFields = fields(raw);
  const contract = fields(bytesAt(rawFields, 11));
  const any = fields(bytesAt(contract, 2));
  const trigger = fields(bytesAt(any, 2));
  return { raw, rawFields, signature, trigger, txId: hex(sha256(raw)) };
}

async function rejection(p: Promise<unknown>): Promise<TronTxError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TronTxError);
    return err as TronTxError;
  }
  throw new Error("expected a rejection, got success");
}

// -- sendTronTx ------------------------------------------------------------

describe("sendTronTx", () => {
  test("sendTronTx resolves on SUCCESS", async () => {
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS", 2);
    const adapter = countingAdapter();
    const receipt = await sendTronTx(params(adapter));

    const sent = broadcasts();
    expect(sent).toHaveLength(1);
    const tx = decodeSent(sent[0]!);
    // The transaction is the caller's call, referencing the solidified
    // block and expiring a minute after the head.
    expect(hex(bytesAt(tx.rawFields, 1))).toBe(
      SOLID_NUMBER.toString(16).padStart(16, "0").slice(12),
    );
    expect(hex(bytesAt(tx.rawFields, 4))).toBe("cd".repeat(8));
    expect(one(tx.rawFields, 8)).toBe(BigInt(HEAD_TIME + 60_000));
    expect(one(tx.rawFields, 18)).toBe(TRON_WITHDRAW_FEE_LIMIT_SUN);
    expect(hex(bytesAt(tx.trigger, 1))).toBe("41" + OWNER.slice(2));
    expect(hex(bytesAt(tx.trigger, 2))).toBe("41" + INSTANCE.slice(2));
    expect(tx.trigger.has(3)).toBe(false); // no call_value
    expect(hex(bytesAt(tx.trigger, 4))).toBe(DATA.slice(2));
    // Signed by the owner over the txID; the receipt names that txID.
    expect(
      (
        await recoverAddress({
          hash: `0x${tx.txId}`,
          signature: `0x${hex(tx.signature)}`,
        })
      ).toLowerCase(),
    ).toBe(OWNER);
    expect(receipt.txId).toBe(tx.txId);
    expect(receipt.blockNumber).toBe(BigInt(SOLID_NUMBER + 21));
    expect(adapter.signed).toEqual([tx.txId]);
    // Every receipt asked about is this transaction's.
    for (const s of at("/wallet/gettransactioninfobyid")) {
      expect(s.body["value"]).toBe(tx.txId);
    }
  });

  test("sendTronTx throws on FAILED with the revert reason", async () => {
    routes["/wallet/gettransactioninfobyid"] = receipts("REVERT", 1);
    const err = await rejection(sendTronTx(params(countingAdapter())));
    const id = decodeSent(broadcasts()[0]!).txId;
    expect(err.sent).toBe(true);
    expect(err.txId).toBe(id);
    expect(err.message).toContain(id);
    expect(err.message).toContain("FAILED");
    expect(err.message).toContain("REVERT opcode executed");
    expect(err.message).toContain("0x90b8ec18");
    // The receipt was read at the head, where it can still be reorged out:
    // the message must not claim the failure is final.
    expect(err.message).toContain("FAILED at the head");
    expect(err.message).toContain("not yet solidified");
    expect(err.message).not.toContain("no effect");
  });

  test("sendTronTx throws on OUT_OF_ENERGY, naming the account", async () => {
    routes["/wallet/gettransactioninfobyid"] = receipts("OUT_OF_ENERGY");
    const err = await rejection(sendTronTx(params(countingAdapter())));
    expect(err.sent).toBe(true);
    expect(err.message).toContain("OUT_OF_ENERGY");
    expect(err.message).toContain(OWNER);
    expect(err.message).toContain("not yet solidified");
    expect(err.message).not.toContain("no effect");
  });

  // Anything but the exact string SUCCESS is a failure, including results
  // the code has never heard of and a receipt with no result at all.
  test("only SUCCESS is success", async () => {
    for (const result of ["FAILED", "SUCCESSFUL", "success", "UNKNOWN", null]) {
      reset();
      routes["/wallet/gettransactioninfobyid"] = receipts(result);
      const err = await rejection(sendTronTx(params(countingAdapter())));
      expect(err.sent).toBe(true);
      expect(err.message).toContain(result ?? "no receipt result");
    }
  });

  test("sendTronTx throws when unseen past expiration", async () => {
    // The head the transaction is built against, then one just past
    // expiration plus a block. No block ever includes it.
    routes["/wallet/getnowblock"] = (_b, nth) =>
      nth === 0
        ? block(SOLID_NUMBER + 19, HEAD_TIME)
        : block(SOLID_NUMBER + 41, EXPIRY_PLUS_BLOCK + 1);
    const err = await rejection(sendTronTx(params(countingAdapter())));
    const id = decodeSent(broadcasts()[0]!).txId;
    expect(err.sent).toBe(true);
    expect(err.message).toContain(id);
    expect(err.message).toContain("UNCONFIRMED");
    expect(err.message).not.toContain("no effect");
  });

  // Exactly at expiration plus one block the transaction can still be in
  // that block: the wait goes on, and the receipt decides.
  test("unseen at the expiration boundary keeps waiting", async () => {
    routes["/wallet/getnowblock"] = (_b, nth) =>
      nth === 0
        ? block(SOLID_NUMBER + 19, HEAD_TIME)
        : block(SOLID_NUMBER + 40, EXPIRY_PLUS_BLOCK);
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS", 5);
    const receipt = await sendTronTx(params(countingAdapter()));
    expect(receipt.txId).toBe(decodeSent(broadcasts()[0]!).txId);
  });

  // A transaction that is still unseen when the expiry is judged gets one
  // last look; a FAILED found there is still a failure.
  test("a receipt found on the last look past expiry decides", async () => {
    routes["/wallet/getnowblock"] = (_b, nth) =>
      nth === 0
        ? block(SOLID_NUMBER + 19, HEAD_TIME)
        : block(SOLID_NUMBER + 41, EXPIRY_PLUS_BLOCK + 1);
    routes["/wallet/gettransactioninfobyid"] = receipts("REVERT", 1);
    const err = await rejection(sendTronTx(params(countingAdapter())));
    expect(err.message).toContain("REVERT opcode executed");
    expect(err.message).not.toContain("UNCONFIRMED");
  });

  test("sendTronTx rebroadcasts the identical hex", async () => {
    // A gateway error, then a transport error, then a busy node; then it
    // takes it.
    routes["/wallet/broadcasthex"] = (_b, nth) =>
      [
        new Response("upstream down", { status: 503 }),
        { throw: "fetch failed" },
        { result: false, code: "SERVER_BUSY", message: hexOf("busy") },
        { result: true },
      ][Math.min(nth, 3)];
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS", 4);
    const adapter = countingAdapter();
    const receipt = await sendTronTx(params(adapter));

    const sent = broadcasts();
    expect(sent).toHaveLength(4);
    for (const s of sent) expect(s).toBe(sent[0]!);
    const id = decodeSent(sent[0]!).txId;
    expect(receipt.txId).toBe(id);
    for (const s of at("/wallet/gettransactioninfobyid")) {
      expect(s.body["value"]).toBe(id);
    }
  });

  test("sendTronTx never re-signs", async () => {
    // Unanswered broadcasts and a long unseen wait: through all of it the
    // wallet is asked once, and the simulation and block reads that precede
    // signing run once.
    routes["/wallet/broadcasthex"] = (_b, nth) =>
      nth < 3 ? new Response("bad gateway", { status: 502 }) : { result: true };
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS", 8);
    const adapter = countingAdapter();
    await sendTronTx(params(adapter));
    expect(adapter.signed).toHaveLength(1);
    expect(at("/wallet/triggerconstantcontract")).toHaveLength(1);
    expect(at("/walletsolidity/getnowblock")).toHaveLength(1);
    expect(new Set(broadcasts()).size).toBe(1);

    // And when it ends in expiry, it is not signed again either.
    reset();
    routes["/wallet/broadcasthex"] = () => ({ throw: "fetch failed" });
    routes["/wallet/getnowblock"] = (_b, nth) =>
      nth === 0
        ? block(SOLID_NUMBER + 19, HEAD_TIME)
        : nth < 4
          ? block(SOLID_NUMBER + 30, HEAD_TIME + 30_000)
          : block(SOLID_NUMBER + 41, EXPIRY_PLUS_BLOCK + 1);
    const again = countingAdapter();
    const err = await rejection(sendTronTx(params(again)));
    expect(err.message).toContain("UNCONFIRMED");
    expect(err.message).not.toContain("no effect");
    expect(again.signed).toHaveLength(1);
    expect(broadcasts().length).toBeGreaterThan(1);
    expect(new Set(broadcasts()).size).toBe(1);
  });

  test("sendTronTx simulates before signing", async () => {
    routes["/wallet/triggerconstantcontract"] = () => ({
      transaction: { ret: [{ ret: "FAILED" }] },
      constant_result: ["90b8ec18"],
      result: { result: true, message: hexOf("REVERT opcode executed") },
    });
    const adapter = countingAdapter();
    const err = await rejection(sendTronTx(params(adapter)));
    expect(err.sent).toBe(false);
    expect(err.message).toContain("REVERT opcode executed");
    expect(err.message).toContain("0x90b8ec18");
    expect(err.message).toContain("nothing was broadcast");
    expect(adapter.signed).toEqual([]);
    expect(at("/wallet/broadcasthex")).toEqual([]);
    // The simulation is the first thing asked.
    expect(seen[0]!.path).toBe("/wallet/triggerconstantcontract");
  });

  test("a simulation the node refuses is a refusal too", async () => {
    routes["/wallet/triggerconstantcontract"] = () => ({
      result: {
        code: "CONTRACT_VALIDATE_ERROR",
        message: hexOf("balance is not sufficient."),
      },
    });
    const adapter = countingAdapter();
    const err = await rejection(sendTronTx(params(adapter)));
    expect(err.sent).toBe(false);
    expect(err.message).toContain("balance is not sufficient.");
    expect(adapter.signed).toEqual([]);
    expect(at("/wallet/broadcasthex")).toEqual([]);
  });

  test("the simulation is the call that is sent", async () => {
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    await sendTronTx(
      params(countingAdapter(), {
        callValueSun: 10_000_000n,
        feeLimitSun: TRON_DEPOSIT_NATIVE_FEE_LIMIT_SUN,
      }),
    );
    const sims = at("/wallet/triggerconstantcontract");
    expect(sims).toHaveLength(1);
    expect(sims[0]!.body).toEqual({
      owner_address: "41" + OWNER.slice(2),
      contract_address: "41" + INSTANCE.slice(2),
      data: DATA.slice(2),
      visible: false,
      call_value: 10_000_000,
    });
    const tx = decodeSent(broadcasts()[0]!);
    expect(one(tx.trigger, 3)).toBe(10_000_000n);
  });

  test("a broadcast refused for funds names the account and is not resent", async () => {
    routes["/wallet/broadcasthex"] = () => ({
      result: false,
      code: "CONTRACT_VALIDATE_ERROR",
      message: hexOf(
        "Validate TriggerSmartContract error, balance is not sufficient.",
      ),
    });
    const err = await rejection(sendTronTx(params(countingAdapter())));
    expect(err.sent).toBe(true);
    expect(err.message).toContain(OWNER);
    expect(err.message).toContain("balance is not sufficient");
    expect(broadcasts()).toHaveLength(1);
  });

  test("a node that already holds the transaction counts as accepted", async () => {
    routes["/wallet/broadcasthex"] = () => ({
      result: false,
      code: "DUP_TRANSACTION_ERROR",
      message: hexOf("dup transaction"),
    });
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS", 2);
    await sendTronTx(params(countingAdapter()));
    expect(broadcasts()).toHaveLength(1);
  });

  // A record for some other transaction is not this one's receipt, even
  // when it says SUCCESS.
  test("a receipt echoing another txID is never success", async () => {
    routes["/wallet/gettransactioninfobyid"] = () => ({
      id: "ab".repeat(32),
      blockNumber: SOLID_NUMBER + 21,
      receipt: { result: "SUCCESS" },
    });
    routes["/wallet/getnowblock"] = (_b, nth) =>
      nth < 3
        ? block(SOLID_NUMBER + 19, HEAD_TIME)
        : block(SOLID_NUMBER + 41, EXPIRY_PLUS_BLOCK + 1);
    const err = await rejection(sendTronTx(params(countingAdapter())));
    expect(err.sent).toBe(true);
    expect(err.message).toContain("whether it landed is unknown");
  });

  // A node whose head never advances cannot prove expiry; the backstop
  // ends the wait as an error, never as success.
  test("a wait that cannot be judged gives up as an error", async () => {
    routes["/wallet/getnowblock"] = (_b, nth) =>
      nth === 0
        ? block(SOLID_NUMBER + 19, HEAD_TIME)
        : new Response("down", { status: 500 });
    const err = await rejection(
      sendTronTx(params(countingAdapter(), { giveUpAfterMs: 30 })),
    );
    expect(err.sent).toBe(true);
    expect(err.message).toContain("whether it landed is unknown");
  });

  test("a wallet signing as another account is refused before broadcast", async () => {
    const other = privateKeyTronAdapter(`0x${"11".repeat(32)}`);
    const err = await rejection(sendTronTx(params(other)));
    expect(err.sent).toBe(false);
    expect(err.message).toContain(`not as ${OWNER}`);
    expect(at("/wallet/broadcasthex")).toEqual([]);
  });

  test("an adapter without signTronTransaction is refused before anything", async () => {
    const err = await rejection(
      sendTronTx(params({ signMessage: async () => "0x" })),
    );
    expect(err.sent).toBe(false);
    expect(seen).toEqual([]);
  });

  test("fails over to the next url and sends the API key", async () => {
    // Every request to the first url fails at the transport (the mock
    // throws for down.example).
    const node: TronNode = {
      urls: ["https://down.example", BASE],
      apiKey: "k-123",
    };
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    await sendTronTx(params(countingAdapter(), { node }));
    const good = seen.filter((s) => s.url.startsWith(BASE));
    const down = seen.filter((s) => s.url.startsWith("https://down.example"));
    expect(good.length).toBeGreaterThan(0);
    expect(down.length).toBe(good.length);
    for (const s of seen) expect(s.headers["tron-pro-api-key"]).toBe("k-123");
  });

  test("no API key header when none is set", async () => {
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    await sendTronTx(params(countingAdapter()));
    for (const s of seen) expect(s.headers["tron-pro-api-key"]).toBeUndefined();
  });
  // -- Fix round: timeouts, signature forms, expiry judgement, 4xx --------

  test("a request that never answers is abandoned, and the send still settles", async () => {
    // After the transaction is built, the node hangs on everything: the
    // broadcast, the receipt and the head. Each request is aborted at the
    // node's timeout, and the backstop ends the wait as an error.
    routes["/wallet/broadcasthex"] = () => HANG;
    routes["/wallet/gettransactioninfobyid"] = () => HANG;
    routes["/wallet/getnowblock"] = (_b, nth) =>
      nth === 0 ? block(SOLID_NUMBER + 19, HEAD_TIME) : HANG;
    const err = await rejection(
      sendTronTx(
        params(countingAdapter(), {
          node: { urls: [BASE], timeoutMs: 20 },
          giveUpAfterMs: 150,
        }),
      ),
    );
    expect(err.sent).toBe(true);
    expect(err.message).toContain("whether it landed is unknown");
    expect(err.message).toContain("UNCONFIRMED");
    expect(broadcasts().length).toBeGreaterThan(1);
    expect(new Set(broadcasts()).size).toBe(1);
  });

  test("a hung broadcast still reaches the expiry judgement", async () => {
    routes["/wallet/broadcasthex"] = () => HANG;
    routes["/wallet/getnowblock"] = (_b, nth) =>
      nth === 0
        ? block(SOLID_NUMBER + 19, HEAD_TIME)
        : block(SOLID_NUMBER + 41, EXPIRY_PLUS_BLOCK + 1);
    const err = await rejection(
      sendTronTx(
        params(countingAdapter(), {
          node: { urls: [BASE], timeoutMs: 20 },
        }),
      ),
    );
    expect(err.message).toContain("UNCONFIRMED");
  });

  test("every request carries an abort signal", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return inner(input, init);
    }) as typeof fetch;
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    await sendTronTx(params(countingAdapter()));
    expect(signals.length).toBeGreaterThan(0);
    for (const sig of signals) expect(sig).toBeInstanceOf(AbortSignal);
  });

  // MetaMask-style wallets may return v as 0/1 rather than 27/28. Both
  // recover to the owner, and the wallet's bytes are broadcast as given.
  test("the recover check accepts v = 0/1 as well as 27/28", async () => {
    const inner = privateKeyTronAdapter(KEY);
    const returned: string[] = [];
    const zeroOne: SigningAdapter = {
      signMessage: inner.signMessage,
      async signTronTransaction(txId, rawDataHex) {
        const sig = await inner.signTronTransaction!(txId, rawDataHex);
        const v = parseInt(sig.slice(-2), 16);
        expect([27, 28]).toContain(v);
        const out = sig.slice(0, -2) + (v - 27).toString(16).padStart(2, "0");
        returned.push(out);
        return out;
      },
    };
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    const receipt = await sendTronTx(params(zeroOne));
    const tx = decodeSent(broadcasts()[0]!);
    expect(receipt.txId).toBe(tx.txId);
    expect("0x" + hex(tx.signature)).toBe(returned[0]!);
    expect([0, 1]).toContain(tx.signature[64]!);

    // And 27/28 as returned by the key adapter.
    reset();
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    await sendTronTx(params(countingAdapter()));
    expect([27, 28]).toContain(decodeSent(broadcasts()[0]!).signature[64]!);
  });

  // Node A lags: it never sees the transaction, and its head read blips, so
  // the head past expiry comes from node B, which does hold the receipt.
  // The last look goes to B, never to A.
  test("a lagging node's unseen is not judged against another node's head", async () => {
    const LAG = "https://lag.example";
    hostRoutes["lag.example"] = {
      "/wallet/gettransactioninfobyid": () => ({}),
      "/wallet/getnowblock": (_b, nth) =>
        nth === 0
          ? block(SOLID_NUMBER + 19, HEAD_TIME)
          : new Response("blip", { status: 502 }),
    };
    routes["/wallet/getnowblock"] = () =>
      block(SOLID_NUMBER + 41, EXPIRY_PLUS_BLOCK + 1);
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    const receipt = await sendTronTx(
      params(countingAdapter(), { node: { urls: [LAG, BASE] } }),
    );
    expect(receipt.txId).toBe(decodeSent(broadcasts()[0]!).txId);
  });

  test("unseen at expiry is UNCONFIRMED, never 'no effect'", async () => {
    const LAG = "https://lag.example";
    hostRoutes["lag.example"] = {
      "/wallet/gettransactioninfobyid": () => ({}),
      "/wallet/getnowblock": (_b, nth) =>
        nth === 0
          ? block(SOLID_NUMBER + 19, HEAD_TIME)
          : new Response("blip", { status: 502 }),
    };
    routes["/wallet/getnowblock"] = () =>
      block(SOLID_NUMBER + 41, EXPIRY_PLUS_BLOCK + 1);
    const err = await rejection(
      sendTronTx(params(countingAdapter(), { node: { urls: [LAG, BASE] } })),
    );
    expect(err.sent).toBe(true);
    expect(err.message).toContain("UNCONFIRMED");
    expect(err.message).toContain("before retrying");
    expect(err.message).not.toContain("no effect");
    // The last receipt look was asked of the node whose head judged expiry.
    const receiptsAsked = at("/wallet/gettransactioninfobyid");
    expect(receiptsAsked.at(-1)!.url.startsWith(BASE)).toBe(true);
  });

  test("a 4xx broadcast is a refusal, not an expiry", async () => {
    routes["/wallet/broadcasthex"] = () =>
      new Response(JSON.stringify({ Error: "bad transaction hex" }), {
        status: 400,
      });
    // Heads would prove expiry if the send kept waiting.
    routes["/wallet/getnowblock"] = (_b, nth) =>
      nth === 0
        ? block(SOLID_NUMBER + 19, HEAD_TIME)
        : block(SOLID_NUMBER + 41, EXPIRY_PLUS_BLOCK + 1);
    const err = await rejection(sendTronTx(params(countingAdapter())));
    expect(err.sent).toBe(true);
    expect(err.message).toContain("HTTP 400");
    expect(err.message).toContain("bad transaction hex");
    expect(err.message).not.toContain("UNCONFIRMED");
    expect(broadcasts()).toHaveLength(1);
  });

  // One url refuses the broadcast while another may have received it (its
  // request timed out): the transaction may have landed, so the outcome is
  // UNCONFIRMED, never a hard refusal.
  test("a 4xx from one url and a hang on another is UNCONFIRMED", async () => {
    hostRoutes["refuse.example"] = {
      "/wallet/broadcasthex": () =>
        new Response(JSON.stringify({ Error: "bad transaction hex" }), {
          status: 400,
        }),
      "/wallet/getnowblock": (_b, nth) =>
        nth === 0
          ? block(SOLID_NUMBER + 19, HEAD_TIME)
          : block(SOLID_NUMBER + 41, EXPIRY_PLUS_BLOCK + 1),
    };
    routes["/wallet/broadcasthex"] = () => HANG;
    const err = await rejection(
      sendTronTx(
        params(countingAdapter(), {
          node: { urls: ["https://refuse.example", BASE], timeoutMs: 20 },
        }),
      ),
    );
    const id = decodeSent(broadcasts()[0]!).txId;
    expect(err.sent).toBe(true);
    expect(err.txId).toBe(id);
    expect(err.message).toContain(id);
    expect(err.message).toContain("UNCONFIRMED");
    expect(err.message).toContain("before retrying");
    expect(err.message).not.toContain("HTTP 400");
    // The hanging url was asked.
    expect(at("/wallet/broadcasthex").some((b) => b.url.startsWith(BASE))).toBe(
      true,
    );
  });

  // A refusal that follows an unanswered broadcast of the same bytes does
  // not prove the first never landed.
  test("a refusal after an unanswered broadcast is UNCONFIRMED", async () => {
    routes["/wallet/broadcasthex"] = (_b, nth) =>
      nth === 0
        ? new Response("upstream down", { status: 503 })
        : {
            result: false,
            code: "CONTRACT_VALIDATE_ERROR",
            message: hexOf("balance is not sufficient."),
          };
    const err = await rejection(sendTronTx(params(countingAdapter())));
    expect(err.sent).toBe(true);
    expect(err.message).toContain("UNCONFIRMED");
    expect(err.message).toContain("balance is not sufficient.");
    expect(err.message).toContain("before retrying");
  });

  test("429 and 403 are rate limits: the same hex goes out again", async () => {
    routes["/wallet/broadcasthex"] = (_b, nth) =>
      nth === 0
        ? new Response("slow down", { status: 429 })
        : nth === 1
          ? new Response("forbidden: rate", { status: 403 })
          : { result: true };
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS", 3);
    await sendTronTx(params(countingAdapter()));
    expect(broadcasts()).toHaveLength(3);
    expect(new Set(broadcasts()).size).toBe(1);
  });

  test("a 4xx read before signing is an error and nothing is signed", async () => {
    routes["/wallet/triggerconstantcontract"] = () =>
      new Response("not found", { status: 404 });
    const adapter = countingAdapter();
    const err = await rejection(sendTronTx(params(adapter)));
    expect(err.sent).toBe(false);
    expect(err.message).toContain("HTTP 404");
    expect(adapter.signed).toEqual([]);
  });

  test("a 4xx from one url still fails over to the next", async () => {
    hostRoutes["bad.example"] = {
      "/wallet/triggerconstantcontract": () =>
        new Response("not found", { status: 404 }),
      "/walletsolidity/getnowblock": () => new Response("nf", { status: 404 }),
      "/wallet/getnowblock": () => new Response("nf", { status: 404 }),
      "/wallet/broadcasthex": () => new Response("nf", { status: 404 }),
      "/wallet/gettransactioninfobyid": () =>
        new Response("nf", { status: 404 }),
    };
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    await sendTronTx(
      params(countingAdapter(), {
        node: { urls: ["https://bad.example", BASE] },
      }),
    );
    expect(broadcasts().length).toBeGreaterThan(0);
  });
});

// -- MidribV3 on Tron ------------------------------------------------------

/** Serves `eth_call` at `/jsonrpc` with `allowance` as the 32-byte answer. */
function jsonRpcAllowance(allowance: bigint): Route {
  return (body) => ({
    jsonrpc: "2.0",
    id: body["id"],
    result: "0x" + allowance.toString(16).padStart(64, "0"),
  });
}

const sender = (adapter: SigningAdapter) => ({
  node: NODE,
  adapter,
  owner: OWNER,
  pollIntervalMs: 1,
});

describe("MidribV3 on Tron", () => {
  test("fee limits are three times the measured energy at 100 sun", () => {
    expect(TRON_APPROVE_FEE_LIMIT_SUN).toBe(6_806_400n);
    expect(TRON_DEPOSIT_FEE_LIMIT_SUN).toBe(26_280_600n);
    expect(TRON_DEPOSIT_NATIVE_FEE_LIMIT_SUN).toBe(9_839_400n);
    expect(TRON_WITHDRAW_FEE_LIMIT_SUN).toBe(25_315_800n);
  });

  test("tronDepositNative sets callValue and sends no approve", async () => {
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    await tronDepositNative({
      ...sender(countingAdapter()),
      contract: INSTANCE,
      amount: 10_000_000n,
    });
    const sent = broadcasts();
    expect(sent).toHaveLength(1);
    const tx = decodeSent(sent[0]!);
    expect(hex(bytesAt(tx.trigger, 2))).toBe("41" + INSTANCE.slice(2));
    expect(one(tx.trigger, 3)).toBe(10_000_000n);
    // depositNative()'s selector, as in the fixture's Nile capture.
    expect("0x" + hex(bytesAt(tx.trigger, 4))).toBe(
      vectors.transactions.deposit_native.fields.data,
    );
    expect(one(tx.rawFields, 18)).toBe(TRON_DEPOSIT_NATIVE_FEE_LIMIT_SUN);
    expect(at("/jsonrpc")).toEqual([]);
    expect(at("/wallet/triggerconstantcontract")[0]!.body["call_value"]).toBe(
      10_000_000,
    );
  });

  test("tronDeposit approves then deposits", async () => {
    routes["/jsonrpc"] = jsonRpcAllowance(0n);
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    const out = await tronDeposit({
      ...sender(countingAdapter()),
      contract: INSTANCE,
      token: USDT,
      amount: 3_000_000n,
    });

    // The allowance read is a plain eth_call of allowance(owner, instance).
    const reads = at("/jsonrpc");
    expect(reads).toHaveLength(1);
    const call = (reads[0]!.body["params"] as Record<string, string>[])[0]!;
    expect(call["to"]).toBe(USDT);
    const read = decodeFunctionData({
      abi: ERC20_APPROVAL_ABI,
      data: call["data"] as Hex,
    });
    expect(read.functionName).toBe("allowance");
    expect((read.args as string[]).map((x) => x.toLowerCase())).toEqual([
      OWNER,
      INSTANCE,
    ]);

    const sent = broadcasts().map(decodeSent);
    expect(sent).toHaveLength(2);
    const [approve, deposit] = sent;
    // approve(instance, amount) to the token.
    expect(hex(bytesAt(approve!.trigger, 2))).toBe("41" + USDT.slice(2));
    const a = decodeFunctionData({
      abi: ERC20_APPROVAL_ABI,
      data: `0x${hex(bytesAt(approve!.trigger, 4))}`,
    });
    expect(a.functionName).toBe("approve");
    expect((a.args![0] as string).toLowerCase()).toBe(INSTANCE);
    expect(a.args![1]).toBe(3_000_000n);
    expect(one(approve!.rawFields, 18)).toBe(TRON_APPROVE_FEE_LIMIT_SUN);
    // deposit(token, amount) to the instance.
    expect(hex(bytesAt(deposit!.trigger, 2))).toBe("41" + INSTANCE.slice(2));
    const d = decodeFunctionData({
      abi: MIDRIB_V3_ABI,
      data: `0x${hex(bytesAt(deposit!.trigger, 4))}`,
    });
    expect(d.functionName).toBe("deposit");
    expect((d.args![0] as string).toLowerCase()).toBe(USDT);
    expect(d.args![1]).toBe(3_000_000n);
    expect(one(deposit!.rawFields, 18)).toBe(TRON_DEPOSIT_FEE_LIMIT_SUN);
    expect(deposit!.trigger.has(3)).toBe(false);

    // The approve's SUCCESS receipt is read before the deposit is even
    // simulated.
    const order = seen.map((s) => s.path);
    const approveReceipt = seen.findIndex(
      (s) =>
        s.path === "/wallet/gettransactioninfobyid" &&
        s.body["value"] === approve!.txId,
    );
    const sims = order
      .map((p, i) => (p === "/wallet/triggerconstantcontract" ? i : -1))
      .filter((i) => i >= 0);
    expect(sims).toHaveLength(2);
    expect(approveReceipt).toBeGreaterThan(-1);
    expect(approveReceipt).toBeLessThan(sims[1]!);
    expect(out.approve?.txId).toBe(approve!.txId);
    expect(out.deposit.txId).toBe(deposit!.txId);
  });

  test("tronDeposit skips the approve when the allowance covers it", async () => {
    routes["/jsonrpc"] = jsonRpcAllowance(3_000_000n);
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    const out = await tronDeposit({
      ...sender(countingAdapter()),
      contract: INSTANCE,
      token: USDT,
      amount: 3_000_000n,
    });
    const sent = broadcasts().map(decodeSent);
    expect(sent).toHaveLength(1);
    expect(hex(bytesAt(sent[0]!.trigger, 2))).toBe("41" + INSTANCE.slice(2));
    expect(out.approve).toBeUndefined();
  });

  test("a failed approve stops the deposit", async () => {
    routes["/jsonrpc"] = jsonRpcAllowance(0n);
    routes["/wallet/gettransactioninfobyid"] = receipts("REVERT");
    const err = await rejection(
      tronDeposit({
        ...sender(countingAdapter()),
        contract: INSTANCE,
        token: USDT,
        amount: 3_000_000n,
      }),
    );
    expect(err.message).toContain("REVERT opcode executed");
    expect(broadcasts()).toHaveLength(1);
    expect(at("/wallet/triggerconstantcontract")).toHaveLength(1);
  });

  test("tronDeposit refuses the native asset", async () => {
    await expect(
      tronDeposit({
        ...sender(countingAdapter()),
        contract: INSTANCE,
        token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        amount: 1n,
      }),
    ).rejects.toThrow(/tronDepositNative/);
    expect(seen).toEqual([]);
  });

  test("tronWithdraw submits the voucher exactly as issued", async () => {
    routes["/wallet/gettransactioninfobyid"] = receipts("SUCCESS");
    const signature = new Uint8Array(65).fill(7);
    await tronWithdraw({
      ...sender(countingAdapter()),
      contract: INSTANCE,
      voucher: {
        account: OWNER,
        token: USDT,
        amount: "2500000",
        nonce: 42n,
        expiry: 1_792_700_000n,
        signature,
      },
    });
    const sent = broadcasts().map(decodeSent);
    expect(sent).toHaveLength(1);
    const tx = sent[0]!;
    expect(hex(bytesAt(tx.trigger, 2))).toBe("41" + INSTANCE.slice(2));
    expect(tx.trigger.has(3)).toBe(false);
    expect(one(tx.rawFields, 18)).toBe(TRON_WITHDRAW_FEE_LIMIT_SUN);
    const w = decodeFunctionData({
      abi: MIDRIB_V3_ABI,
      data: `0x${hex(bytesAt(tx.trigger, 4))}`,
    });
    expect(w.functionName).toBe("withdraw");
    const [v, sig] = w.args as [Record<string, unknown>, string];
    expect((v["account"] as string).toLowerCase()).toBe(OWNER);
    expect((v["token"] as string).toLowerCase()).toBe(USDT);
    expect(v["amount"]).toBe(2_500_000n);
    expect(v["nonce"]).toBe(42n);
    expect(v["expiry"]).toBe(1_792_700_000n);
    expect(sig).toBe("0x" + "07".repeat(65));
  });

  test("a reverted withdraw rejects", async () => {
    routes["/wallet/gettransactioninfobyid"] = receipts("REVERT");
    const err = await rejection(
      tronWithdraw({
        ...sender(countingAdapter()),
        contract: INSTANCE,
        voucher: {
          account: OWNER,
          token: USDT,
          amount: "1",
          nonce: 1n,
          expiry: 1n,
          signature: new Uint8Array(65),
        },
      }),
    );
    expect(err.sent).toBe(true);
  });
});

// -- The TRX check before a withdraw voucher -------------------------------

/** Serves `eth_getBalance` at `/jsonrpc` with `sun` as the answer. */
function jsonRpcBalance(sun: bigint): Route {
  return (body) => ({
    jsonrpc: "2.0",
    id: body["id"],
    result: "0x" + sun.toString(16),
  });
}

describe("assertTronWithdrawTrx", () => {
  test("the floor is the Rust SDK's: 84,386 energy x 100 sun + 604,000 sun", () => {
    expect(TRON_MIN_TRX_FOR_WITHDRAW_SUN).toBe(9_042_600n);
  });

  test("passes at the floor, reading the owner's balance over /jsonrpc", async () => {
    routes["/jsonrpc"] = jsonRpcBalance(9_042_600n);
    await assertTronWithdrawTrx({
      node: NODE,
      owner: OWNER.toUpperCase().replace("0X", "0x"),
    });
    const reads = at("/jsonrpc");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.body["method"]).toBe("eth_getBalance");
    expect((reads[0]!.body["params"] as string[])[0]).toBe(OWNER);
    // A check only: nothing simulated, signed or broadcast.
    expect(at("/wallet/triggerconstantcontract")).toEqual([]);
    expect(broadcasts()).toEqual([]);
  });

  test("one sun short throws, naming the account and the amounts", async () => {
    routes["/jsonrpc"] = jsonRpcBalance(9_042_599n);
    const err = await assertTronWithdrawTrx({ node: NODE, owner: OWNER }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("insufficient TRX");
    expect(err.message).toContain(OWNER);
    expect(err.message).toContain("9042599 sun");
    expect(err.message).toContain("9042600 sun");
    expect(err.message).toContain("No voucher requested");
  });
});
