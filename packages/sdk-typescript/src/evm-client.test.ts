import { describe, expect, it } from "bun:test";
import { publicClientFor, walletChainMismatch } from "./evm-client.js";
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
