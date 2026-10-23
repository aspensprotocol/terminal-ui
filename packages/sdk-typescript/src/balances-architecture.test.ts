/**
 * Which read path each chain architecture takes in the balances fetch.
 *
 * A Tron chain is read with the EVM code, through its node's `/jsonrpc`
 * endpoint under the configured HTTP base; an unknown architecture is an
 * error, not a chain to skip or to read as EVM.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

  test("an unknown architecture is refused, not skipped", async () => {
    await expect(
      fetchChainBalanceSlices({
        wallets: [{ ecosystem: "evm", address: ACCOUNT }],
        config: configWith("sui"),
      }),
    ).rejects.toThrow(/sui/);
  });
});
