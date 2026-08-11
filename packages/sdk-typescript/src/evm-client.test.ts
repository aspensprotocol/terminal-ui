import { describe, expect, it } from "bun:test";
import { publicClientFor, walletChainMismatch } from "./evm-client.js";
import { MASKED_RPC_URL } from "./rpc-urls.js";

const coston2 = {
  network: "flare-coston2",
  rpcUrl: MASKED_RPC_URL,
  chainId: 114,
};

describe("publicClientFor", () => {
  it("builds a client from the override map when the config url is masked", () => {
    const c = publicClientFor(coston2, {
      "flare-coston2": "https://coston2-api.flare.network/ext/C/rpc",
    });
    expect(c.transport.url).toBe("https://coston2-api.flare.network/ext/C/rpc");
  });

  it("throws rather than silently using a default RPC", () => {
    // The original bug: no usable endpoint meant viem fell back to its own
    // public mainnet RPC and the read went to the wrong network entirely.
    expect(() => publicClientFor(coston2, undefined)).toThrow(
      /No RPC endpoint for 'flare-coston2' \(chain 114\)/,
    );
  });

  it("falls back to the config url when it is not masked", () => {
    const c = publicClientFor(
      { ...coston2, rpcUrl: "https://from-config.example/rpc" },
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
      rpcUrl: MASKED_RPC_URL,
      chainId: 998,
    };
    expect(walletChainMismatch(hyper, 114)).toContain("998");
  });
});
