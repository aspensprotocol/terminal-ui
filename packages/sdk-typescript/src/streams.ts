/**
 * Server streams from the arborter, as async iterables.
 *
 * `Trades` and `Orderbook` are server-streaming RPCs that chain the history a
 * request asks for into a live broadcast, and never end on their own. Two
 * layers are offered:
 *
 * - {@link streamTrades} / {@link streamOrderbook} — one call, each message
 *   exactly as the server sent it, ending when the caller aborts or breaks out
 *   of the loop (either cancels the underlying HTTP request) and throwing when
 *   the stream fails.
 * - {@link subscribeTrades} / {@link subscribeOrderbook} — reconnect forever
 *   with jittered exponential backoff, re-requesting history on every connect,
 *   and report the connection's life as typed events instead of throwing.
 *
 * Neither layer deduplicates: every reconnect replays the history, and two
 * genuinely identical prints are both real. A consumer that keeps state
 * reconciles each replay itself — `connected` marks where one starts.
 */

import { ConnectError, Code, type Transport } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";

import {
  createArborterClient,
  getDefaultTransport,
  type ArborterClient,
} from "./grpc-transport.js";
import {
  OrderbookRequestSchema,
  TradeRequestSchema,
  type OrderbookEntry,
  type Trade,
} from "./protos/arborter_pb.js";

/** What to stream. */
export interface StreamParams {
  marketId: string;
  /**
   * Replay the history first — closed trades for `Trades`, resting orders for
   * `Orderbook` — then continue live. Defaults to false (live only).
   */
  historical?: boolean;
  /** Restrict to one trader's address. */
  filterByTrader?: string;
}

/** How to reach the arborter, and when to stop. */
export interface StreamOptions {
  /**
   * Ends the stream. Aborting cancels the underlying request — including one
   * still waiting for its response headers — and ends iteration without an
   * error.
   */
  signal?: AbortSignal;
  /** Transport to call over. Defaults to the module's default transport. */
  transport?: Transport;
  /** A ready-made client; takes precedence over `transport`. */
  client?: ArborterClient;
}

/**
 * The `Trades` stream for one market, message by message.
 *
 * Ends quietly when `opts.signal` aborts or the consumer stops iterating; the
 * request is cancelled either way. Throws (a `ConnectError`) when the call
 * fails, and returns when the server closes the stream.
 */
export function streamTrades(
  params: StreamParams,
  opts: StreamOptions = {},
): AsyncIterable<Trade> {
  const request = create(TradeRequestSchema, {
    marketId: params.marketId,
    historicalClosedTrades: params.historical,
    filterByTrader: params.filterByTrader,
  });
  return cancellable(
    (signal, onHeader) =>
      resolveClient(opts).trades(request, { signal, onHeader }),
    opts.signal,
  );
}

/**
 * The `Orderbook` stream for one market, entry by entry. Same lifecycle as
 * {@link streamTrades}.
 */
export function streamOrderbook(
  params: StreamParams,
  opts: StreamOptions = {},
): AsyncIterable<OrderbookEntry> {
  const request = create(OrderbookRequestSchema, {
    marketId: params.marketId,
    historicalOpenOrders: params.historical,
    filterByTrader: params.filterByTrader,
  });
  return cancellable(
    (signal, onHeader) =>
      resolveClient(opts).orderbook(request, { signal, onHeader }),
    opts.signal,
  );
}

// -- reconnecting subscriptions ------------------------------------------

/** Backoff between reconnects. */
export interface BackoffOptions {
  /** Delay before the first retry. Default 1 000 ms. */
  initialMs?: number;
  /** Ceiling the doubling stops at. Default 30 000 ms. */
  maxMs?: number;
  /**
   * A connection that stays up this long, or delivers any message, resets the
   * backoff to `initialMs`. Default 10 000 ms.
   */
  resetAfterMs?: number;
  /** Source of jitter in [0, 1). Default `Math.random`. */
  random?: () => number;
}

export interface SubscribeOptions extends StreamOptions {
  backoff?: BackoffOptions;
}

/** What a reconnecting subscription reports. */
export type StreamEvent<T> =
  /**
   * The server answered: response headers or a first message arrived. Every
   * message after this one, up to the next `disconnected`, belongs to one
   * connection, and that connection starts with a full history replay.
   *
   * An idle market may send nothing at all — not even headers — until its
   * first message, so the absence of `connected` means "waiting", not
   * "broken": no timeout is applied to it.
   */
  | { type: "connected"; attempt: number }
  | { type: "message"; message: T }
  /**
   * The connection ended — the server closed it or it failed — and a
   * reconnect is scheduled in `retryInMs`.
   */
  | {
      type: "disconnected";
      reason: string;
      /** The gRPC status code, when the connection failed with one. */
      code?: Code;
      retryInMs: number;
      /** Reconnects since the last healthy connection, counting this one. */
      attempt: number;
    }
  /**
   * A failure retrying cannot fix (the request itself is refused). The
   * subscription ends after this event.
   */
  | { type: "error"; error: ConnectError; code: Code };

/** {@link StreamEvent} for trades, with the message under `trade`. */
export type TradeStreamEvent =
  | Exclude<StreamEvent<Trade>, { type: "message" }>
  | { type: "trade"; trade: Trade };

/** {@link StreamEvent} for book entries, with the message under `entry`. */
export type OrderbookStreamEvent =
  | Exclude<StreamEvent<OrderbookEntry>, { type: "message" }>
  | { type: "entry"; entry: OrderbookEntry };

/**
 * Trades for one market, reconnecting until `opts.signal` aborts or the
 * consumer stops iterating. Every (re)connect requests the full history, so
 * each `connected` is followed by a replay.
 */
export async function* subscribeTrades(
  params: Omit<StreamParams, "historical">,
  opts: SubscribeOptions = {},
): AsyncGenerator<TradeStreamEvent> {
  const request = create(TradeRequestSchema, {
    marketId: params.marketId,
    historicalClosedTrades: true,
    filterByTrader: params.filterByTrader,
  });
  for await (const event of resilient(
    (signal, onHeader) =>
      resolveClient(opts).trades(request, { signal, onHeader }),
    opts,
  )) {
    yield event.type === "message"
      ? { type: "trade", trade: event.message }
      : event;
  }
}

/**
 * Book entries for one market, reconnecting like {@link subscribeTrades};
 * every (re)connect replays the resting orders.
 */
export async function* subscribeOrderbook(
  params: Omit<StreamParams, "historical">,
  opts: SubscribeOptions = {},
): AsyncGenerator<OrderbookStreamEvent> {
  const request = create(OrderbookRequestSchema, {
    marketId: params.marketId,
    historicalOpenOrders: true,
    filterByTrader: params.filterByTrader,
  });
  for await (const event of resilient(
    (signal, onHeader) =>
      resolveClient(opts).orderbook(request, { signal, onHeader }),
    opts,
  )) {
    yield event.type === "message"
      ? { type: "entry", entry: event.message }
      : event;
  }
}

/**
 * The jittered delay before reconnect number `attempt` (1-based): the doubling
 * delay capped at `maxMs`, of which a random half is kept, so a fleet of
 * clients dropped together does not return together.
 */
export function backoffDelay(attempt: number, backoff: BackoffOptions = {}) {
  const initial = backoff.initialMs ?? 1_000;
  const max = backoff.maxMs ?? 30_000;
  const random = backoff.random ?? Math.random;
  const ceiling = Math.min(max, initial * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

// -- internals -----------------------------------------------------------

type Open<T> = (
  signal: AbortSignal,
  onHeader: (headers: Headers) => void,
) => AsyncIterable<T>;

/** Request refusals that the same request will meet again on a reconnect. */
const TERMINAL_CODES = new Set<Code>([
  Code.InvalidArgument,
  Code.NotFound,
  Code.Unimplemented,
  Code.PermissionDenied,
  Code.Unauthenticated,
]);

function resolveClient(opts: StreamOptions): ArborterClient {
  return (
    opts.client ?? createArborterClient(opts.transport ?? getDefaultTransport())
  );
}

/**
 * Run one call with an abort signal of its own, linked to the caller's, and
 * abort it however iteration ends — a `break`, a throw, or the caller's
 * signal. Ceasing to read is not enough: the request would stay open.
 */
async function* cancellable<T>(
  open: Open<T>,
  outer: AbortSignal | undefined,
): AsyncGenerator<T> {
  if (outer?.aborted) return;
  const call = new AbortController();
  const unlink = link(outer, call);
  try {
    for await (const message of open(call.signal, () => {})) {
      yield message;
    }
  } catch (error) {
    if (outer?.aborted) return;
    throw error;
  } finally {
    unlink();
    call.abort();
  }
}

/**
 * Reconnect `open` until stopped, as events.
 *
 * The connection is driven by a background pump feeding a queue, so
 * `connected` can be reported the moment response headers arrive rather than
 * only alongside a first message — a quiet market may not send one for hours.
 */
async function* resilient<T>(
  open: Open<T>,
  opts: SubscribeOptions,
): AsyncGenerator<StreamEvent<T>> {
  const stop = new AbortController();
  const unlink = link(opts.signal, stop);
  const queue = new EventQueue<StreamEvent<T>>();
  // Stopping must end the consumer's wait even if a transport ignores the
  // abort; the pump's own exit closes the queue too.
  stop.signal.addEventListener("abort", () => queue.close(), { once: true });

  void pump(open, opts.backoff ?? {}, stop.signal, queue).finally(() =>
    queue.close(),
  );

  try {
    for await (const event of queue) yield event;
  } finally {
    unlink();
    stop.abort();
  }
}

async function pump<T>(
  open: Open<T>,
  backoff: BackoffOptions,
  stop: AbortSignal,
  queue: EventQueue<StreamEvent<T>>,
): Promise<void> {
  const resetAfterMs = backoff.resetAfterMs ?? 10_000;
  let attempt = 0;

  while (!stop.aborted) {
    const call = new AbortController();
    const unlink = link(stop, call);
    let connectedAt: number | undefined;
    let delivered = false;
    const markConnected = () => {
      if (connectedAt !== undefined) return;
      connectedAt = Date.now();
      queue.push({ type: "connected", attempt });
    };

    let reason = "stream closed by the server";
    let code: Code | undefined;
    try {
      for await (const message of open(call.signal, markConnected)) {
        markConnected();
        delivered = true;
        queue.push({ type: "message", message });
      }
    } catch (error) {
      if (stop.aborted) return;
      const failure = ConnectError.from(error);
      if (TERMINAL_CODES.has(failure.code)) {
        queue.push({ type: "error", error: failure, code: failure.code });
        return;
      }
      reason = failure.message;
      code = failure.code;
    } finally {
      unlink();
      call.abort();
    }
    if (stop.aborted) return;

    const healthy =
      delivered ||
      (connectedAt !== undefined && Date.now() - connectedAt >= resetAfterMs);
    attempt = healthy ? 1 : attempt + 1;
    const retryInMs = backoffDelay(attempt, backoff);
    queue.push({ type: "disconnected", reason, code, retryInMs, attempt });
    await sleep(retryInMs, stop);
  }
}

/** Abort `target` when `source` aborts. Returns the unlink function. */
function link(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * An unbounded push queue read as an async iterable. Unbounded because the
 * producer is a network stream that cannot be paused without dropping the
 * connection; a consumer that falls behind buffers instead.
 */
class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  /** Stop accepting items. Items already queued are still delivered. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({
            value: this.items.shift() as T,
            done: false,
          });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
