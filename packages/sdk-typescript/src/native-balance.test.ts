import { describe, expect, it } from "bun:test";
import { readEvmWalletBalance, solanaNativeWallet } from "./balances.js";
import { NATIVE_TOKEN_SENTINEL, WSOL_MINT } from "./native.js";

const USER = "0xB3ECe804B5f0cA097B2897Bbb2DdA3c6B2943308";
const ERC20 = "0xaB6FaD89389B73dBC887d31206A26Fd88d719d1F";

/** Records which viem method each call took. */
function fakeClient(opts: {
  getBalance?: bigint | Error;
  readContract?: bigint | Error;
}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      getBalance: async () => {
        calls.push("getBalance");
        if (opts.getBalance instanceof Error) throw opts.getBalance;
        return opts.getBalance ?? 0n;
      },
      readContract: async () => {
        calls.push("readContract");
        if (opts.readContract instanceof Error) throw opts.readContract;
        return opts.readContract ?? 0n;
      },
    },
  };
}

describe("readEvmWalletBalance", () => {
  it("uses getBalance for the native sentinel, not balanceOf", async () => {
    // The bug: balanceOf was called on 0xEeee…EEeE, which has no code, so the
    // call reverted and the catch turned it into 0 — a wallet holding 94 FLR
    // rendered as empty.
    const { client, calls } = fakeClient({ getBalance: 94872198523075000000n });
    const got = await readEvmWalletBalance(
      client as never,
      NATIVE_TOKEN_SENTINEL,
      USER as never,
    );
    expect(got).toBe(94872198523075000000n);
    expect(calls).toEqual(["getBalance"]);
  });

  it("matches the sentinel case-insensitively", async () => {
    const { client, calls } = fakeClient({ getBalance: 5n });
    await readEvmWalletBalance(
      client as never,
      NATIVE_TOKEN_SENTINEL.toLowerCase(),
      USER as never,
    );
    expect(calls).toEqual(["getBalance"]);
  });

  it("still uses balanceOf for a real ERC-20", async () => {
    const { client, calls } = fakeClient({ readContract: 120n });
    const got = await readEvmWalletBalance(
      client as never,
      ERC20,
      USER as never,
    );
    expect(got).toBe(120n);
    expect(calls).toEqual(["readContract"]);
  });

  it("degrades to zero when the read fails, on either path", async () => {
    const nat = fakeClient({ getBalance: new Error("rpc down") });
    expect(
      await readEvmWalletBalance(
        nat.client as never,
        NATIVE_TOKEN_SENTINEL,
        USER as never,
      ),
    ).toBe(0n);

    const erc = fakeClient({ readContract: new Error("rpc down") });
    expect(
      await readEvmWalletBalance(erc.client as never, ERC20, USER as never),
    ).toBe(0n);
  });
});

describe("solanaNativeWallet", () => {
  it("adds lamports to any already-wrapped WSOL for the WSOL mint", async () => {
    const conn = {
      getBalance: async () => 2_000_000_000,
      getTokenAccountBalance: async () => ({ value: { amount: "500000000" } }),
    };
    const got = await solanaNativeWallet(
      conn as never,
      WSOL_MINT,
      {} as never,
      {} as never,
    );
    expect(got).toBe(2_500_000_000n);
  });

  it("counts lamports even with no WSOL account yet", async () => {
    const conn = {
      getBalance: async () => 3_000_000_000,
      getTokenAccountBalance: async () => {
        throw new Error("could not find account");
      },
    };
    const got = await solanaNativeWallet(
      conn as never,
      WSOL_MINT,
      {} as never,
      {} as never,
    );
    expect(got).toBe(3_000_000_000n);
  });

  it("ignores lamports for an ordinary SPL mint", async () => {
    const conn = {
      getBalance: async () => 9_000_000_000,
      getTokenAccountBalance: async () => ({ value: { amount: "77" } }),
    };
    const got = await solanaNativeWallet(
      conn as never,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      {} as never,
      {} as never,
    );
    expect(got).toBe(77n);
  });
});
