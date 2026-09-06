/**
 * Two live subscriptions to the SAME market must hold two pollers and each
 * unsubscribe must clear exactly its own. The composite orderbook view
 * subscribes to every member market, including the one the single-market
 * book is already polling, so a key that is just `orderbook:<marketId>`
 * would let the second subscription overwrite the first's interval and
 * leak it for the life of the page.
 *
 * The poller fires immediately and its gRPC call fails (nothing listens on
 * the URL below); that failure is caught inside the poller and is not what
 * this test observes.
 */
import { describe, expect, test } from "bun:test";
import { ExchangeClient } from "./client.js";

type Peek = { pollingIntervals: Map<string, unknown> };

describe("subscription keys", () => {
  test("two orderbook subscriptions to one market hold two intervals and unsubscribe independently", () => {
    const client = new ExchangeClient("http://127.0.0.1:1");
    const intervals = (client as unknown as Peek).pollingIntervals;
    const noop = () => {};

    const first = client.onOrderbook("market-a", noop);
    const second = client.onOrderbook("market-a", noop);
    expect(intervals.size).toBe(2);

    first();
    expect(intervals.size).toBe(1);
    second();
    expect(intervals.size).toBe(0);

    client.disconnect();
  });

  test("trades subscriptions get the same treatment", () => {
    const client = new ExchangeClient("http://127.0.0.1:1");
    const intervals = (client as unknown as Peek).pollingIntervals;
    const noop = () => {};

    const first = client.onTrades("market-a", noop);
    const second = client.onTrades("market-a", noop);
    expect(intervals.size).toBe(2);

    first();
    second();
    expect(intervals.size).toBe(0);

    client.disconnect();
  });
});
