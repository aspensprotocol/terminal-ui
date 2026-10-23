import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { publicClientFor, walletChainMismatch } from "./evm-client.js";
import { readEvmWalletBalance } from "./balances.js";
import { readEvmFeeRates, readTradeBalance } from "./midrib-evm.js";
import { tronPublicClient } from "./tron-client.js";
import { MASKED_RPC_URL, PUBLIC_RPC_URLS } from "./rpc-urls.js";

const coston2 = {
  network: "flare-coston2",
  rpcs: [{ url: MASKED_RPC_URL, enabled: true }],
  chainId: 114,
};

describe("publicClientFor", () => {
  // The override differs from chain 114's public-list url, so this cannot
  // pass by the fallback answering instead.
  it("builds a client from the override map when the config url is masked", () => {
    const c = publicClientFor(coston2, {
      "flare-coston2": "https://override.example/rpc",
    });
    expect(c.transport.url).toBe("https://override.example/rpc");
  });

  it("falls back to the chain's own public endpoint, not viem's default", () => {
    const c = publicClientFor(coston2, undefined);
    expect(c.transport.url).toBe(PUBLIC_RPC_URLS.evm[114]);
  });

  it("throws rather than silently using a default RPC", () => {
    // The original bug: no usable endpoint meant viem fell back to its own
    // public mainnet RPC and the read went to the wrong network entirely.
    // 31337 (a local anvil) is on no public list.
    const anvil = { ...coston2, network: "anvil", chainId: 31337 };
    expect(() => publicClientFor(anvil, undefined)).toThrow(
      /No RPC endpoint for 'anvil' \(chain 31337\)/,
    );
  });

  it("falls back to the config url when it is not masked", () => {
    const c = publicClientFor(
      {
        ...coston2,
        rpcs: [{ url: "https://from-config.example/rpc", enabled: true }],
      },
      {},
    );
    expect(c.transport.url).toBe("https://from-config.example/rpc");
  });

  it("skips a disabled endpoint and falls through to the next enabled one", () => {
    const c = publicClientFor(
      {
        ...coston2,
        rpcs: [
          { url: "https://disabled.example/rpc", enabled: false },
          { url: "https://from-config.example/rpc", enabled: true },
        ],
      },
      {},
    );
    expect(c.transport.url).toBe("https://from-config.example/rpc");
  });
});

describe("walletChainMismatch", () => {
  it("returns null when the wallet is on the right chain", () => {
    expect(walletChainMismatch(coston2, 114)).toBeNull();
  });

  it("names both chains when they differ", () => {
    const msg = walletChainMismatch(coston2, 1);
    expect(msg).toContain("chain 1");
    expect(msg).toContain("flare-coston2");
    expect(msg).toContain("114");
  });

  it("treats a disconnected wallet as not-a-mismatch", () => {
    expect(walletChainMismatch(coston2, undefined)).toBeNull();
  });

  it("catches the HyperEVM case, which wagmi never had configured", () => {
    const hyper = {
      network: "hyperevm-testnet",
      rpcs: [{ url: MASKED_RPC_URL, enabled: true }],
      chainId: 998,
    };
    expect(walletChainMismatch(hyper, 114)).toContain("998");
  });
});

// -- Tron reads ------------------------------------------------------------

describe("publicClientFor on a Tron chain", () => {
  const NILE_BASE = "https://nile.example/node";
  const nile = {
    network: "tron-nile",
    chainId: 3448148188,
    architecture: "Tron",
    rpcs: [{ url: NILE_BASE, enabled: true }],
  };
  const realFetch = globalThis.fetch;
  let requests: { url: string; body: Record<string, unknown> }[] = [];

  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url: String(input), body });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: "0x" + (7).toString(16).padStart(64, "0"),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("tron public client targets /jsonrpc", () => {
    expect(publicClientFor(nile, undefined).transport.url).toBe(
      `${NILE_BASE}/jsonrpc`,
    );
    // An override is the HTTP base too.
    expect(
      publicClientFor(nile, { "tron-nile": "https://other.example" }).transport
        .url,
    ).toBe("https://other.example/jsonrpc");
  });

  it("a masked Tron chain falls back to TronGrid's /jsonrpc", () => {
    const masked = { ...nile, rpcs: [{ url: MASKED_RPC_URL, enabled: true }] };
    expect(publicClientFor(masked, undefined).transport.url).toBe(
      "https://nile.trongrid.io/jsonrpc",
    );
  });

  it("an EVM chain is not given /jsonrpc", () => {
    const evm = { ...nile, architecture: "EVM", chainId: 990001 };
    expect(publicClientFor(evm, undefined).transport.url).toBe(NILE_BASE);
  });

  it("a Solana or unknown chain gets no EVM client", () => {
    expect(() =>
      publicClientFor({ ...nile, architecture: "Solana" }, undefined),
    ).toThrow(/Solana chain; it has no EVM public client/);
    expect(() =>
      publicClientFor({ ...nile, architecture: "sui" }, undefined),
    ).toThrow(/sui/);
  });

  // Tron's JSON-RPC rejects an eth_call carrying chainId, type, accessList
  // or EIP-1559 fee fields. The EVM readers must send only {to, data}.
  it("the EVM readers send a legacy-shaped eth_call to /jsonrpc", async () => {
    const client = publicClientFor(nile, undefined);
    const holder = "0xa5411a1a5784b0828bbafcfa588c72ef3f3ce646";
    const token = "0xeca9bc828a3005b9a3b909f2cc5c2a54794de05f";
    const instance = "0xc76d503a0aecd5115aa23639fe90e2de7ad63719";
    expect(await readTradeBalance(client, instance, holder, token)).toBe(7n);
    expect(await readEvmFeeRates(client, instance)).toEqual({
      maintenanceBps: 7,
      operatorBps: 7,
    });
    expect(await readEvmWalletBalance(client, token, holder)).toBe(7n);
    expect(
      await readEvmWalletBalance(
        client,
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
        holder,
      ),
    ).toBe(7n);

    expect(requests.length).toBe(5);
    for (const r of requests) expect(r.url).toBe(`${NILE_BASE}/jsonrpc`);
    const calls = requests.filter((r) => r.body["method"] === "eth_call");
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      const [tx, tag] = c.body["params"] as [Record<string, unknown>, string];
      expect(Object.keys(tx).sort()).toEqual(["data", "to"]);
      expect(tag).toBe("latest");
    }
    const balance = requests.find((r) => r.body["method"] === "eth_getBalance");
    expect(balance?.body["params"]).toEqual([holder, "latest"]);
  });

  it("tronPublicClient sends the API key and fails over in order", async () => {
    const seen: { url: string; key: string | null }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      seen.push({
        url,
        key: new Headers(init?.headers).get("TRON-PRO-API-KEY"),
      });
      if (url.startsWith("https://down.example")) {
        return new Response("down", { status: 503 });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x2a" }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const client = tronPublicClient({
      urls: ["https://down.example", NILE_BASE],
      apiKey: "k-123",
    });
    expect(await client.getBalance({ address: OWNER_HEX })).toBe(42n);
    expect(seen.at(-1)!.url).toBe(`${NILE_BASE}/jsonrpc`);
    expect(seen.some((s) => s.url === "https://down.example/jsonrpc")).toBe(
      true,
    );
    for (const s of seen) expect(s.key).toBe("k-123");
  });
});

const OWNER_HEX = "0xa5411a1a5784b0828bbafcfa588c72ef3f3ce646";
