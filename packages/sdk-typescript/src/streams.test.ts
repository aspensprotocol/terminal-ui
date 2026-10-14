/**
 * Server streams: raw iteration, cancellation, and the reconnecting wrapper.
 *
 * The arborter is stood in for by connect's in-memory router transport, whose
 * handlers see the real decoded request and an abort signal that fires when
 * the client cancels — so "abort cancels the call" is observed on the server
 * side, not inferred from the iterator stopping. One case needs a transport
 * that never answers at all (a quiet market sends no headers until its first
 * message); that one is hand-written.
 */

import { describe, expect, test } from "bun:test";
import {
  Code,
  ConnectError,
  createRouterTransport,
  type Transport,
} from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";

import {
  ArborterService,
  TradeSchema,
  type Trade,
  type TradeRequest,
} from "./protos/arborter_pb.js";
import {
  backoffDelay,
  streamOrderbook,
  streamTrades,
  subscribeTrades,
  type TradeStreamEvent,
} from "./streams.js";

const MARKET = "net-a::0xaa::net-b::0xbb";

function trade(n: number): Trade {
  return create(TradeSchema, {
    timestamp: BigInt(1_700_000_000_000 + n),
    price: `${1000 + n}`,
    qty: `${7 + n}`,
    marketId: MARKET,
  });
}

/** Resolves when `signal` aborts — a handler that "stays open". */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Fail the test instead of hanging it. */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms),
    ),
  ]);
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("streamTrades", () => {
  test("sends the request fields and yields each message as sent", async () => {
    const requests: TradeRequest[] = [];
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades(request) {
          requests.push(request);
          yield trade(1);
          yield trade(2);
        },
      });
    });

    const got: Trade[] = [];
    for await (const t of streamTrades(
      { marketId: MARKET, historical: true, filterByTrader: "0xabc" },
      { transport },
    )) {
      got.push(t);
    }

    expect(got.map((t) => t.qty)).toEqual(["8", "9"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.marketId).toBe(MARKET);
    expect(requests[0]!.historicalClosedTrades).toBe(true);
    expect(requests[0]!.filterByTrader).toBe("0xabc");
  });

  test("aborting mid-stream cancels the server call and ends iteration quietly", async () => {
    let serverSignal: AbortSignal | undefined;
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades(_request, context) {
          serverSignal = context.signal;
          yield trade(1);
          await untilAborted(context.signal);
        },
      });
    });

    const abort = new AbortController();
    const got: Trade[] = [];
    await within(
      1000,
      (async () => {
        for await (const t of streamTrades(
          { marketId: MARKET },
          { transport, signal: abort.signal },
        )) {
          got.push(t);
          abort.abort();
        }
      })(),
    );

    expect(got).toHaveLength(1);
    expect(serverSignal?.aborted).toBe(true);
  });

  test("breaking out of the loop cancels the server call", async () => {
    let serverSignal: AbortSignal | undefined;
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades(_request, context) {
          serverSignal = context.signal;
          yield trade(1);
          await untilAborted(context.signal);
        },
      });
    });

    for await (const _ of streamTrades({ marketId: MARKET }, { transport })) {
      break;
    }
    await tick();
    expect(serverSignal?.aborted).toBe(true);
  });

  test("a failed call throws", async () => {
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades() {
          throw new ConnectError("no such market", Code.NotFound);
        },
      });
    });
    let caught: unknown;
    try {
      for await (const _ of streamTrades({ marketId: MARKET }, { transport })) {
        // unreachable
      }
    } catch (error) {
      caught = error;
    }
    expect(ConnectError.from(caught).code).toBe(Code.NotFound);
  });

  test("streamOrderbook sends historicalOpenOrders", async () => {
    let historical: boolean | undefined;
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *orderbook(request) {
          historical = request.historicalOpenOrders;
        },
      });
    });
    for await (const _ of streamOrderbook(
      { marketId: MARKET, historical: true },
      { transport },
    )) {
      // empty
    }
    expect(historical).toBe(true);
  });
});

/**
 * A transport whose streams never answer — no headers, no message — until
 * aborted, the way a quiet market behaves behind the deployed gRPC-Web front.
 */
function silentTransport() {
  const signals: AbortSignal[] = [];
  const transport = {
    unary() {
      throw new Error("not used");
    },
    stream(_method: unknown, signal: AbortSignal | undefined) {
      signals.push(signal!);
      return new Promise((_, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new ConnectError("aborted", Code.Canceled)),
          { once: true },
        );
      });
    },
  } as unknown as Transport;
  return { transport, signals };
}

describe("a stream that never answers", () => {
  test("streamTrades: an abort while pending cancels the request and ends quietly", async () => {
    const { transport, signals } = silentTransport();
    const abort = new AbortController();
    const done = (async () => {
      for await (const _ of streamTrades(
        { marketId: MARKET },
        { transport, signal: abort.signal },
      )) {
        // nothing ever arrives
      }
    })();
    await tick(20);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    abort.abort();
    await within(1000, done);
    expect(signals[0]!.aborted).toBe(true);
  });

  test("subscribeTrades: waits without reconnecting or reporting, then aborts cleanly", async () => {
    const { transport, signals } = silentTransport();
    const abort = new AbortController();
    const events: TradeStreamEvent[] = [];
    const done = (async () => {
      for await (const event of subscribeTrades(
        { marketId: MARKET },
        {
          transport,
          signal: abort.signal,
          // Tiny delays: were silence treated as a failure, many reconnects
          // would happen inside the wait below.
          backoff: { initialMs: 1, maxMs: 2 },
        },
      )) {
        events.push(event);
      }
    })();
    await tick(50);
    // Silence is not a connection, and not a failure.
    expect(events).toEqual([]);
    expect(signals).toHaveLength(1);
    abort.abort();
    await within(1000, done);
    expect(signals[0]!.aborted).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("subscribeTrades", () => {
  test("reconnects after a failure and re-requests history each time", async () => {
    const requests: TradeRequest[] = [];
    let call = 0;
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades(request, context) {
          requests.push(request);
          call += 1;
          if (call === 1) {
            yield trade(1);
            throw new ConnectError("upstream reset", Code.Unavailable);
          }
          yield trade(1);
          yield trade(2);
          await untilAborted(context.signal);
        },
      });
    });

    const abort = new AbortController();
    const events: TradeStreamEvent[] = [];
    await within(
      2000,
      (async () => {
        for await (const event of subscribeTrades(
          { marketId: MARKET },
          {
            transport,
            signal: abort.signal,
            backoff: { initialMs: 8, random: () => 0.5 },
          },
        )) {
          events.push(event);
          if (events.filter((e) => e.type === "trade").length === 3) {
            abort.abort();
          }
        }
      })(),
    );

    const summary = events.map((e) =>
      e.type === "trade"
        ? `trade:${e.trade.qty}`
        : e.type === "disconnected"
          ? `disconnected:${e.code}:${e.retryInMs}:${e.attempt}`
          : e.type === "connected"
            ? `connected:${e.attempt}`
            : e.type,
    );
    // A connection that delivered a message was healthy, so the retry is the
    // FIRST backoff step: half of 8 ms plus half of the jitter range.
    expect(summary).toEqual([
      "connected:0",
      "trade:8",
      `disconnected:${Code.Unavailable}:6:1`,
      "connected:1",
      "trade:8",
      "trade:9",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.historicalClosedTrades === true)).toBe(true);
  });

  test("each connection that delivered a message resets the backoff", async () => {
    // Every call delivers one print and then fails. Each was healthy, so each
    // retry is the first step again rather than a growing one.
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades() {
          yield trade(1);
          throw new ConnectError("flap", Code.Unavailable);
        },
      });
    });
    const retries: [number, number][] = [];
    for await (const event of subscribeTrades(
      { marketId: MARKET },
      { transport, backoff: { initialMs: 2, random: () => 1 } },
    )) {
      if (event.type === "disconnected") {
        retries.push([event.attempt, event.retryInMs]);
      }
      if (retries.length === 3) break;
    }
    expect(retries).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
  });

  test("a stream the server closes is reconnected too", async () => {
    let calls = 0;
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades() {
          calls += 1;
          yield trade(calls);
        },
      });
    });
    const events: TradeStreamEvent[] = [];
    for await (const event of subscribeTrades(
      { marketId: MARKET },
      { transport, backoff: { initialMs: 2 } },
    )) {
      events.push(event);
      if (event.type === "trade" && event.trade.qty === "9") break;
    }
    const closed = events.find((e) => e.type === "disconnected");
    expect(closed).toMatchObject({
      type: "disconnected",
      reason: "stream closed by the server",
      code: undefined,
    });
    expect(calls).toBe(2);
  });

  test("a refusal retrying cannot fix ends the subscription with an error", async () => {
    let calls = 0;
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades() {
          calls += 1;
          throw new ConnectError("bad market id", Code.InvalidArgument);
        },
      });
    });
    const events: TradeStreamEvent[] = [];
    await within(
      1000,
      (async () => {
        for await (const event of subscribeTrades(
          { marketId: MARKET },
          { transport, backoff: { initialMs: 1 } },
        )) {
          events.push(event);
        }
      })(),
    );
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") expect(last.code).toBe(Code.InvalidArgument);
    expect(events.some((e) => e.type === "disconnected")).toBe(false);
    expect(calls).toBe(1);
  });

  test("consecutive failures back off exponentially up to the ceiling", async () => {
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades() {
          throw new ConnectError("down", Code.Unavailable);
        },
      });
    });
    const delays: number[] = [];
    for await (const event of subscribeTrades(
      { marketId: MARKET },
      // random() = 1 keeps the whole doubled delay, exposing the sequence.
      { transport, backoff: { initialMs: 2, maxMs: 10, random: () => 1 } },
    )) {
      if (event.type === "disconnected") delays.push(event.retryInMs);
      if (delays.length === 5) break;
    }
    expect(delays).toEqual([2, 4, 8, 10, 10]);
  });

  test("breaking out of the loop cancels the live call", async () => {
    let serverSignal: AbortSignal | undefined;
    const transport = createRouterTransport(({ service }) => {
      service(ArborterService, {
        async *trades(_request, context) {
          serverSignal = context.signal;
          yield trade(1);
          await untilAborted(context.signal);
        },
      });
    });
    for await (const event of subscribeTrades(
      { marketId: MARKET },
      { transport },
    )) {
      if (event.type === "trade") break;
    }
    await tick();
    expect(serverSignal?.aborted).toBe(true);
  });
});

describe("backoffDelay", () => {
  test("defaults run 1 s to 30 s, keeping between half and all of each step", () => {
    expect(backoffDelay(1, { random: () => 0 })).toBe(500);
    expect(backoffDelay(1, { random: () => 1 })).toBe(1_000);
    expect(backoffDelay(2, { random: () => 1 })).toBe(2_000);
    expect(backoffDelay(5, { random: () => 1 })).toBe(16_000);
    expect(backoffDelay(6, { random: () => 1 })).toBe(30_000);
    expect(backoffDelay(60, { random: () => 0 })).toBe(15_000);
  });
});
