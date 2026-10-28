/**
 * The order of a Tron withdraw's steps, and the deposit's native/token
 * split. Every fake records into one shared log, so a sequence that signs
 * or asks for a voucher before the TRX check, or submits a voucher whose
 * amount differs from the request, reads differently from the right one.
 */

import { describe, expect, test } from "bun:test";
import {
  NATIVE_TOKEN_SENTINEL,
  type EvmWithdrawalVoucher,
  type SigningAdapter,
  type TronSender,
} from "@aspensprotocol/sdk-ts";
import {
  depositOnTron,
  withdrawOnTron,
  type TronTransferDeps,
  type TronTransferTarget,
} from "./tron-transfer";

const OWNER = "0xcf7d5ed79ca1fb60e040cde086c0be1b25289c7a";
const CONTRACT = "0x1111111111111111111111111111111111111111";
const USDT = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
const SIGNATURE = new Uint8Array(65).fill(7);

const adapter: SigningAdapter = {
  signMessage: async () => {
    throw new Error("not used");
  },
};
const sender: TronSender = {
  node: { urls: ["https://nile.trongrid.io"] },
  adapter,
  owner: OWNER,
};
const target: TronTransferTarget = {
  network: "tron-nile",
  architecture: "Tron",
  contract: CONTRACT,
  token: USDT,
  amount: 1_500_000n,
};

function voucherFor(amount: string): EvmWithdrawalVoucher {
  return {
    account: OWNER,
    token: USDT,
    amount,
    nonce: 9n,
    expiry: 1_900_000_000n,
    signature: new Uint8Array(65).fill(3),
  };
}

function recorder(opts: { trxShort?: boolean } = {}) {
  const log: { step: string; args: unknown[] }[] = [];
  const deps: TronTransferDeps = {
    assertTronWithdrawTrx: async (...args) => {
      log.push({ step: "assertTrx", args });
      if (opts.trxShort) throw new Error("insufficient TRX");
    },
    signWithdrawRequest: async (...args) => {
      log.push({ step: "sign", args });
      return SIGNATURE;
    },
    tronDeposit: async (...args) => {
      log.push({ step: "deposit", args });
      return {} as Awaited<ReturnType<TronTransferDeps["tronDeposit"]>>;
    },
    tronDepositNative: async (...args) => {
      log.push({ step: "depositNative", args });
      return {} as Awaited<ReturnType<TronTransferDeps["tronDepositNative"]>>;
    },
    tronWithdraw: async (...args) => {
      log.push({ step: "withdraw", args });
      return {} as Awaited<ReturnType<TronTransferDeps["tronWithdraw"]>>;
    },
  };
  return { log, deps, steps: () => log.map((e) => e.step) };
}

describe("withdrawOnTron", () => {
  test("checks TRX, signs the canonical text for the Tron chain, then fetches and submits", async () => {
    const r = recorder();
    const requests: unknown[] = [];
    await withdrawOnTron(
      sender,
      target,
      {
        requestVoucher: async (req) => {
          r.log.push({ step: "voucher", args: [req] });
          requests.push(req);
          return voucherFor("1500000");
        },
      },
      r.deps,
    );

    expect(r.steps()).toEqual(["assertTrx", "sign", "voucher", "withdraw"]);
    expect(r.log[0]!.args[0]).toEqual({ node: sender.node, owner: OWNER });
    const [text, signingAdapter, architecture] = r.log[1]!.args;
    expect(text).toBe(`tron-nile|${USDT}|${OWNER}|1500000`);
    expect(signingAdapter).toBe(adapter);
    expect(architecture).toBe("Tron");
    expect(requests[0]).toEqual({
      network: "tron-nile",
      token: USDT,
      account: OWNER,
      amount: "1500000",
      signature: SIGNATURE,
    });
    const submitted = r.log[3]!.args[0] as {
      contract: string;
      voucher: unknown;
    };
    expect(submitted.contract).toBe(CONTRACT);
    expect(submitted.voucher).toEqual(voucherFor("1500000"));
  });

  test("short of TRX: nothing is signed and no voucher (no hold) is requested", async () => {
    const r = recorder({ trxShort: true });
    let asked = false;
    await expect(
      withdrawOnTron(
        sender,
        target,
        {
          requestVoucher: async () => {
            asked = true;
            return voucherFor("1500000");
          },
        },
        r.deps,
      ),
    ).rejects.toThrow(/TRX/);
    expect(r.steps()).toEqual(["assertTrx"]);
    expect(asked).toBe(false);
  });

  test("a voucher for another amount is not submitted", async () => {
    const r = recorder();
    await expect(
      withdrawOnTron(
        sender,
        target,
        { requestVoucher: async () => voucherFor("1500001") },
        r.deps,
      ),
    ).rejects.toThrow(/1500001/);
    expect(r.steps()).toEqual(["assertTrx", "sign"]);
  });
});

describe("depositOnTron", () => {
  test("TRX (the native sentinel) goes through depositNative with the amount as call value", async () => {
    const r = recorder();
    await depositOnTron(
      sender,
      { ...target, token: NATIVE_TOKEN_SENTINEL },
      r.deps,
    );
    expect(r.steps()).toEqual(["depositNative"]);
    expect(r.log[0]!.args[0]).toMatchObject({
      contract: CONTRACT,
      amount: 1_500_000n,
      owner: OWNER,
    });
  });

  test("a token goes through deposit, naming the token", async () => {
    const r = recorder();
    await depositOnTron(sender, target, r.deps);
    expect(r.steps()).toEqual(["deposit"]);
    expect(r.log[0]!.args[0]).toMatchObject({
      contract: CONTRACT,
      token: USDT,
      amount: 1_500_000n,
      owner: OWNER,
    });
  });
});
