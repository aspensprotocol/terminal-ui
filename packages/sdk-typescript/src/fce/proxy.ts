/**
 * FCE extension-proxy client — `POST /direct` + poll `/action/result/{id}`.
 * Mirrors the Rust `aspens::fce::proxy` and Aspens' `send-direct` client.
 *
 * `ActionResult.data` is go-ethereum `hexutil.Bytes` (`0x`-hex, NOT base64) of
 * `json.Marshal(<arborter response>)` — decode via `hexJsonToObject`.
 */

import type { Hex } from "viem";
import {
  buildDirectInstruction,
  hexJsonToObject,
  OP_COMMAND,
  type OpCommand,
} from "./wire.js";
import type {
  CancelOrderRequest,
  CancelOrderResponse,
  ExportHistoryRequest,
  ExportHistoryResponse,
  GetBookStateRequest,
  GetBookStateResponse,
  GetMyStateRequest,
  GetMyStateResponse,
  PlaceOrderRequest,
  PlaceOrderResponse,
  WithdrawRequest,
  WithdrawVoucher,
} from "./payloads.js";
import type { GetConfigEnvelope } from "./config.js";

export interface FceClientOptions {
  /** ext-proxy EXTERNAL endpoint (host :6674, i.e. EXT_PROXY_URL). */
  proxyUrl: string;
  /** the proxy's DIRECT_API_KEY (sent as X-API-Key). */
  apiKey?: string;
  /** result-poll attempts (default 15). */
  pollAttempts?: number;
  /** result-poll interval in ms (default 2000). */
  pollIntervalMs?: number;
}

/** The decoded outcome of a direct action. */
export interface Outcome<T> {
  /** 1 = ok, 0 = error. */
  status: number;
  /** "ok" or "error: <msg>". */
  log: string;
  /** typed data, present only on status=1 with a response. */
  data?: T;
}

interface ActionResultJson {
  status: number;
  log: string;
  data?: Hex;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Client for the FCE direct-action channel. Uses the global `fetch` (browser /
 * Node 18+). Config discovery stays on gRPC — this client is trading-actions only.
 */
export class FceClient {
  private readonly proxyUrl: string;
  private readonly apiKey?: string;
  private readonly pollAttempts: number;
  private readonly pollIntervalMs: number;

  constructor(opts: FceClientOptions) {
    this.proxyUrl = opts.proxyUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.pollAttempts = opts.pollAttempts ?? 15;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
  }

  // ---- typed direct actions ----

  placeOrder(req: PlaceOrderRequest): Promise<Outcome<PlaceOrderResponse>> {
    return this.action(OP_COMMAND.PLACE_ORDER, req);
  }
  cancelOrder(req: CancelOrderRequest): Promise<Outcome<CancelOrderResponse>> {
    return this.action(OP_COMMAND.CANCEL_ORDER, req);
  }
  /** WITHDRAW returns a MidribV3 voucher on success. */
  withdraw(req: WithdrawRequest): Promise<Outcome<WithdrawVoucher>> {
    return this.action(OP_COMMAND.WITHDRAW, req);
  }
  /** Point-in-time snapshot (not a live stream). */
  getBookState(
    req: GetBookStateRequest,
  ): Promise<Outcome<GetBookStateResponse>> {
    return this.action(OP_COMMAND.GET_BOOK_STATE, req);
  }
  /** Point-in-time snapshot (not a live stream). */
  getMyState(req: GetMyStateRequest): Promise<Outcome<GetMyStateResponse>> {
    return this.action(OP_COMMAND.GET_MY_STATE, req);
  }
  /** Point-in-time snapshot (not a live stream). */
  exportHistory(
    req: ExportHistoryRequest,
  ): Promise<Outcome<ExportHistoryResponse>> {
    return this.action(OP_COMMAND.EXPORT_HISTORY, req);
  }

  /**
   * Config discovery over FCE — the arborter's `GetConfigResponse` as opaque
   * protobuf bytes. Lets a client build signed orders with no arborter gRPC
   * reachability at all. Decode with `decodeConfigEnvelope`.
   */
  getConfig(): Promise<Outcome<GetConfigEnvelope>> {
    return this.action(OP_COMMAND.GET_CONFIG, {});
  }

  // ---- generic action = submit + poll + decode ----

  async action<Resp>(
    command: OpCommand,
    payload: unknown,
  ): Promise<Outcome<Resp>> {
    const id = await this.submitDirect(command, payload);
    const result = await this.pollResult(id);
    const data =
      result.status === 1 && result.data && result.data !== "0x"
        ? hexJsonToObject<Resp>(result.data)
        : undefined;
    return { status: result.status, log: result.log, data };
  }

  /** `POST /direct` a DirectInstruction; returns the 0x-hex action id. */
  async submitDirect(command: OpCommand, payload: unknown): Promise<Hex> {
    const di = buildDirectInstruction(command, payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;

    const resp = await fetch(`${this.proxyUrl}/direct`, {
      method: "POST",
      headers,
      body: JSON.stringify(di),
    });
    if (!resp.ok) {
      throw new Error(`POST /direct -> ${resp.status}: ${await resp.text()}`);
    }
    const body = (await resp.json()) as { data?: { id?: Hex } };
    const id = body.data?.id;
    if (!id) throw new Error("/direct response missing data.id");
    return id;
  }

  /** Poll `GET /action/result/{id}?submissionTag=submit` until a 200. */
  async pollResult(id: Hex): Promise<ActionResultJson> {
    const url = `${this.proxyUrl}/action/result/${id}?submissionTag=submit`;
    for (let i = 0; i < this.pollAttempts; i++) {
      const resp = await fetch(url);
      if (resp.ok) {
        const body = (await resp.json()) as { result: ActionResultJson };
        return body.result;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new Error(
      `no result after ${this.pollAttempts} polls (action ${id})`,
    );
  }
}
