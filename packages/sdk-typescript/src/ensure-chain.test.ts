import { describe, expect, it } from "bun:test";
import { ensureWalletChain } from "./evm-client.js";

const coston2 = {
  network: "flare-coston2",
  rpcUrl: "https://coston2-api.flare.network/ext/C/rpc",
  chainId: 114,
};

/** Fake connector whose chain id changes only when the switch succeeds. */
function fakeWallet(start: number | undefined, opts: { fail?: Error } = {}) {
  const state = { chainId: start, switches: [] as number[] };
  return {
    state,
    deps: {
      currentChainId: () => state.chainId,
      requestSwitch: async (id: number) => {
        state.switches.push(id);
        if (opts.fail) throw opts.fail;
        state.chainId = id;
      },
    },
  };
}

describe("ensureWalletChain", () => {
  it("does nothing when the wallet is already on the right chain", async () => {
    const w = fakeWallet(114);
    await ensureWalletChain(coston2, w.deps);
    expect(w.state.switches).toEqual([]);
  });

  it("switches when the wallet is on another chain", async () => {
    // The reported case: on HyperEVM (998), depositing a Coston2 token.
    const w = fakeWallet(998);
    await ensureWalletChain(coston2, w.deps);
    expect(w.state.switches).toEqual([114]);
    expect(w.state.chainId).toBe(114);
  });

  it("reports the user's rejection without losing the original reason", async () => {
    const w = fakeWallet(998, {
      fail: new Error("User rejected the request."),
    });
    await expect(ensureWalletChain(coston2, w.deps)).rejects.toThrow(
      /Wallet is on chain 998.*flare-coston2 is chain 114.*User rejected/s,
    );
  });

  it("re-checks after switching rather than trusting it resolved", async () => {
    // switchChain resolving is not proof the connector settled on the new
    // chain, so a silent no-op must still be caught before any write.
    const deps = {
      currentChainId: () => 998,
      requestSwitch: async () => {
        /* resolves, but the wallet never moves */
      },
    };
    await expect(ensureWalletChain(coston2, deps)).rejects.toThrow(
      /Wallet is on chain 998/,
    );
  });

  it("does not switch when no wallet is connected", async () => {
    // chainId undefined = disconnected; the caller handles that separately
    // and must not be shown a network prompt for it.
    const w = fakeWallet(undefined);
    await ensureWalletChain(coston2, w.deps);
    expect(w.state.switches).toEqual([]);
  });

  it("announces the switch exactly once, before prompting", async () => {
    const seen: string[] = [];
    const w = fakeWallet(998);
    await ensureWalletChain(coston2, {
      ...w.deps,
      requestSwitch: async (id: number) => {
        seen.push("prompt");
        await w.deps.requestSwitch(id);
      },
      onSwitching: () => seen.push("announce"),
    });
    expect(seen).toEqual(["announce", "prompt"]);
  });
});
