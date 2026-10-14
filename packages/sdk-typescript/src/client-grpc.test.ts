/**
 * `ExchangeClient` over an injected transport: each client calls through its
 * own, configuration failures surface instead of turning into stub markets,
 * `placeOrder` returns the fills the venue answered with, and the polling
 * reads cancel the stream they collected from.
 */

import { describe, expect, test } from "bun:test";
import {
  Code,
  ConnectError,
  createRouterTransport,
  type Transport,
} from "@connectrpc/connect";

import { ExchangeClient, type PlaceOrderParams } from "./client.js";
import { ArborterService } from "./protos/arborter_pb.js";
import { ConfigService } from "./protos/arborter_config_pb.js";
import { STUB_MARKETS, STUB_TOKENS } from "./stub-data.js";

function configTransport(marketIds: string[]): Transport {
  return createRouterTransport(({ service }) => {
    service(ConfigService, {
      getConfig() {
        return {
          config: {
            chains: [{ network: "net-a", chainId: 1, architecture: "EVM" }],
            markets: marketIds.map((marketId) => ({
              marketId,
              name: marketId,
              baseChainNetwork: "net-a",
              quoteChainNetwork: "net-a",
              pairDecimals: 6,
            })),
          },
        };
      },
    });
  });
}

const failingTransport = createRouterTransport(({ service }) => {
  service(ConfigService, {
    getConfig() {
      throw new ConnectError("backend down", Code.Unavailable);
    },
  });
});

describe("per-client transport", () => {
  test("two clients each call through their own transport", async () => {
    const a = new ExchangeClient({
      grpcUrl: "http://unused.invalid",
      grpcTransport: configTransport(["a::0x1::a::0x2"]),
    });
    const b = new ExchangeClient({
      grpcUrl: "http://unused.invalid",
      grpcTransport: configTransport(["b::0x3::b::0x4"]),
    });
    // Constructing b after a must not redirect a.
    expect((await a.getMarkets()).map((m) => m.id)).toEqual(["a::0x1::a::0x2"]);
    expect((await b.getMarkets()).map((m) => m.id)).toEqual(["b::0x3::b::0x4"]);
    expect(a.grpc.transport).not.toBe(b.grpc.transport);
  });
});

describe("configuration failures are not hidden behind stub data", () => {
  const client = () =>
    new ExchangeClient({
      grpcUrl: "http://unused.invalid",
      grpcTransport: failingTransport,
    });

  test("getMarkets throws", async () => {
    await expect(client().getMarkets()).rejects.toThrow(/backend down/);
  });

  test("getTokens throws", async () => {
    await expect(client().getTokens()).rejects.toThrow(/backend down/);
  });

  test("a venue with no markets yields none, not the stubs", async () => {
    const c = new ExchangeClient({
      grpcUrl: "http://unused.invalid",
      grpcTransport: configTransport([]),
    });
    expect(await c.getMarkets()).toEqual([]);
  });

  test("the stubs are served only when asked for", async () => {
    const c = new ExchangeClient({
      grpcUrl: "http://unused.invalid",
      grpcTransport: failingTransport,
      allowStubData: true,
    });
    expect(await c.getMarkets()).toBe(STUB_MARKETS);
    expect(await c.getTokens()).toBe(STUB_TOKENS);
  });
});

describe("placeOrder returns the venue's answer", () => {
  const ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const params: PlaceOrderParams = {
    userAddress: ADDRESS,
    marketId: "a::0x1::a::0x2",
    side: "buy",
    orderType: "limit",
    sizeRaw: "3000000",
    priceRaw: "2500000",
    pairDecimals: 6,
    signature: new Uint8Array(65).fill(1),
    baseAccountAddress: ADDRESS,
    quoteAccountAddress: ADDRESS,
    nonce: 5n,
  };
  const ORDER_HIT = new Uint8Array(32).map((_, i) => i + 1);

  test("fills are adapted with their raw fields, and orderInBook is carried", async () => {
    const client = new ExchangeClient({
      grpcUrl: "http://unused.invalid",
      grpcTransport: createRouterTransport(({ service }) => {
        service(ArborterService, {
          sendOrder() {
            return {
              orderId: new Uint8Array(32).fill(0xab),
              orderInBook: false,
              trades: [
                {
                  timestamp: 1_700_000_000_123n,
                  price: "2400000",
                  qty: "1000000",
                  makerBaseAddress: "0xmakerbase",
                  makerQuoteAddress: "0xmakerquote",
                  takerBaseAddress: ADDRESS,
                  takerQuoteAddress: ADDRESS,
                  buyerIs: 2,
                  sellerIs: 1,
                  orderHit: ORDER_HIT,
                  marketId: "a::0x1::a::0x2",
                },
                {
                  // A hidden maker: its order id and addresses redacted.
                  timestamp: 1_700_000_000_123n,
                  price: "2500000",
                  qty: "2000000",
                  takerBaseAddress: ADDRESS,
                  takerQuoteAddress: ADDRESS,
                  buyerIs: 2,
                  sellerIs: 1,
                  marketId: "a::0x1::a::0x2",
                },
              ],
            };
          },
        });
      }),
    });

    const placed = await client.placeOrder(params);
    expect(placed.orderInBook).toBe(false);
    expect(placed.trades).toHaveLength(2);

    const [visible, hidden] = placed.trades;
    expect(visible).toMatchObject({
      marketId: "a::0x1::a::0x2",
      timestampMs: 1_700_000_000_123n,
      priceRaw: "2400000",
      qtyRaw: "1000000",
      buyerIs: 2,
      sellerIs: 1,
      makerBaseAddress: "0xmakerbase",
      makerQuoteAddress: "0xmakerquote",
      takerBaseAddress: ADDRESS,
      takerQuoteAddress: ADDRESS,
      orderHit:
        "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    });
    expect(hidden!.orderHit).toBe("");
    expect(hidden!.makerBaseAddress).toBe("");
  });

  test("an order that rests reports orderInBook and no fills", async () => {
    const client = new ExchangeClient({
      grpcUrl: "http://unused.invalid",
      grpcTransport: createRouterTransport(({ service }) => {
        service(ArborterService, {
          sendOrder() {
            return { orderId: new Uint8Array(32).fill(1), orderInBook: true };
          },
        });
      }),
    });
    const placed = await client.placeOrder(params);
    expect(placed.orderInBook).toBe(true);
    expect(placed.trades).toEqual([]);
    expect(placed.status).toBe("pending");
  });
});

describe("polling reads close the stream they read", () => {
  test("getTrades returns the history and cancels the open stream", async () => {
    let serverSignal: AbortSignal | undefined;
    const client = new ExchangeClient({
      grpcUrl: "http://unused.invalid",
      grpcTransport: createRouterTransport(({ service }) => {
        service(ArborterService, {
          async *trades(_request, context) {
            serverSignal = context.signal;
            yield { timestamp: 1n, price: "1", qty: "1", marketId: "m" };
            yield { timestamp: 2n, price: "2", qty: "2", marketId: "m" };
            // The live broadcast: open until the client goes away.
            await new Promise((resolve) =>
              context.signal.addEventListener("abort", resolve),
            );
          },
        });
      }),
    });

    const trades = await client.getTrades("0xuser", "m");
    expect(trades.map((t) => t.size)).toEqual(["1", "2"]);
    await new Promise((r) => setTimeout(r, 5));
    expect(serverSignal?.aborted).toBe(true);
  });
});
