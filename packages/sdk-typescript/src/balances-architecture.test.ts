/**
 * Which read path each chain architecture takes in the balances fetch.
 *
 * A Tron chain is read with the EVM code, through its node's `/jsonrpc`
 * endpoint under the configured HTTP base. A chain whose architecture is
 * unknown is never read, as EVM or otherwise: it is left out and named as
 * OMITTED, and every other chain's balances still come back.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";

import { fetchChainBalanceSlices } from "./balances.js";
import {
  ConfigurationSchema,
  type Configuration,
} from "./protos/arborter_config_pb.js";

// From the shared Tron vector fixture (Nile).
const ACCOUNT = "0xa5411a1a5784b0828bbafcfa588c72ef3f3ce646";
const USDT = "0xeca9bc828a3005b9a3b909f2cc5c2a54794de05f";
const INSTANCE = "0xc76d503a0aecd5115aa23639fe90e2de7ad63719";

function configWith(architecture: string): Configuration {
  return create(ConfigurationSchema, {
    chains: [
      {
        network: "tron-nile",
        chainId: 3448148188,
        architecture,
        rpcs: [{ url: "https://nile.example/node", enabled: true }],
        tradeContract: { address: INSTANCE },
        tokens: { USDT: { address: USDT, decimals: 6, symbol: "USDT" } },
      },
    ],
  });
}

const realFetch = globalThis.fetch;
let urls: string[] = [];

beforeEach(() => {
  urls = [];
  // Answers every JSON-RPC call with the 32-byte word 1234; records where
  // it was sent.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    const body = JSON.parse(String(init?.body ?? "{}"));
    const answer = (req: { id: number }) => ({
      jsonrpc: "2.0",
      id: req.id,
      result: "0x" + (1234).toString(16).padStart(64, "0"),
    });
    const payload = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchChainBalanceSlices by architecture", () => {
  test("a Tron chain is read with the EVM code at <base>/jsonrpc", async () => {
    const slices = await fetchChainBalanceSlices({
      wallets: [{ ecosystem: "tron", address: ACCOUNT }],
      config: configWith("Tron"),
    });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls)
      expect(url).toBe("https://nile.example/node/jsonrpc");
    expect(slices).toHaveLength(1);
    expect(slices[0]!.wallet).toBe(1234n);
    expect(slices[0]!.deposited).toBe(1234n);
  });

  test("fetchChainBalanceSlices includes a tron chain", async () => {
    // The config's url is masked, as GetConfig serves it: the chain is
    // still read, through TronGrid's public base for its chain id.
    const config = configWith("Tron");
    config.chains[0]!.rpcs[0]!.url = "********";
    const slices = await fetchChainBalanceSlices({
      wallets: [{ ecosystem: "tron", address: ACCOUNT }],
      config,
    });
    expect(slices.map((s) => [s.chainNetwork, s.tokenTicker])).toEqual([
      ["tron-nile", "USDT"],
    ]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls)
      expect(url).toBe("https://nile.trongrid.io/jsonrpc");
  });

  test("a Tron chain is not read with an EVM wallet binding", async () => {
    const slices = await fetchChainBalanceSlices({
      wallets: [{ ecosystem: "evm", address: ACCOUNT }],
      config: configWith("Tron"),
    });
    expect(slices).toEqual([]);
    expect(urls).toEqual([]);
  });

  test("an EVM chain is read at its configured url, not /jsonrpc", async () => {
    await fetchChainBalanceSlices({
      wallets: [{ ecosystem: "evm", address: ACCOUNT }],
      config: configWith("EVM"),
    });
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toBe("https://nile.example/node");
  });

  test("an unknown chain is omitted and named; tron and evm still come back", async () => {
    const config = create(ConfigurationSchema, {
      chains: [
        {
          network: "tron-nile",
          chainId: 3448148188,
          architecture: "Tron",
          rpcs: [{ url: "https://nile.example/node", enabled: true }],
          tradeContract: { address: INSTANCE },
          tokens: { USDT: { address: USDT, decimals: 6, symbol: "USDT" } },
        },
        {
          network: "bogus-chain",
          chainId: 77,
          architecture: "sui",
          rpcs: [{ url: "https://bogus.example/rpc", enabled: true }],
          tradeContract: { address: INSTANCE },
          tokens: { BOG: { address: USDT, decimals: 6, symbol: "BOG" } },
        },
        {
          network: "evm-chain",
          chainId: 990001,
          architecture: "EVM",
          rpcs: [{ url: "https://evm.example/rpc", enabled: true }],
          tradeContract: { address: INSTANCE },
          tokens: { USDC: { address: USDT, decimals: 6, symbol: "USDC" } },
        },
      ],
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const slices = await fetchChainBalanceSlices({
        wallets: [
          { ecosystem: "evm", address: ACCOUNT },
          { ecosystem: "tron", address: ACCOUNT },
        ],
        config,
      });
      expect(slices.map((s) => s.chainNetwork).sort()).toEqual([
        "evm-chain",
        "tron-nile",
      ]);
      // The bogus chain was not read at all, under any path.
      expect(urls.some((u) => u.includes("bogus"))).toBe(false);
      expect(new Set(urls)).toEqual(
        new Set([
          "https://nile.example/node/jsonrpc",
          "https://evm.example/rpc",
        ]),
      );
      // It is surfaced, by network and by the architecture string.
      const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warned).toContain("bogus-chain");
      expect(warned).toContain('"sui"');
      expect(warned).toContain("OMITTED");
    } finally {
      warn.mockRestore();
    }
  });
});
