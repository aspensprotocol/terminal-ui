/**
 * MidribV3 call builders and reads, pinned to bytes produced outside this
 * module.
 *
 * Calldata and return encodings come from Foundry's `cast calldata` /
 * `cast abi-encode` over the Solidity signatures, and every selector used was
 * checked against the method identifiers of a MidribV3 compiled from arborter
 * `chains/evm/src` (deposit 0x03fde255, depositNative 0xdb6b5246, withdraw
 * 0x4e5c6e4e, tradeBalance 0x19d5f0c3, maintenanceBps 0x2e673446,
 * operatorBps 0xc4109253). Amounts and nonces exceed 2^64 where the type
 * allows, so a narrowed encoding shows.
 */

import { describe, expect, test } from "bun:test";
import { createPublicClient, custom, encodeFunctionData, type Hex } from "viem";

import {
  evmApproveCall,
  evmDepositCall,
  evmDepositNativeCall,
  evmWithdrawCall,
  readEvmFeeRates,
  readTradeBalance,
  withdrawRequestMessage,
} from "./midrib-evm.js";
import { hexToBytes } from "./signing.js";

const MIDRIB = "0x104fBc016F4bb334D775a19E8A6510109AC63E00";
const TOKEN = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9";
const BOB = "0x1D96F2f6BeF1202E4Ce1Ff6Dad0c2CB002861d3e";

describe("withdrawRequestMessage", () => {
  test("joins network, token, account and amount with '|', verbatim", () => {
    // The venue rebuilds `format!("{}|{}|{}|{}", network, token, account,
    // amount)` from the request fields (arborter money_flow_conservation.rs),
    // so case is kept exactly as given and the amount is a plain decimal.
    expect(
      withdrawRequestMessage({
        network: "base-sepolia",
        token: TOKEN,
        account: BOB,
        amount: 123_456_789_012_345_678_901n,
      }),
    ).toBe(
      "base-sepolia|0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9|0x1D96F2f6BeF1202E4Ce1Ff6Dad0c2CB002861d3e|123456789012345678901",
    );
  });

  test("keeps base58 accounts and mints as given", () => {
    expect(
      withdrawRequestMessage({
        network: "solana-devnet",
        token: "So11111111111111111111111111111111111111112",
        account: "29jGKkZXzh1NJSUzU3kHV3vv3VYi9W7NTeErA7DQwN3b",
        amount: 5n,
      }),
    ).toBe(
      "solana-devnet|So11111111111111111111111111111111111111112|29jGKkZXzh1NJSUzU3kHV3vv3VYi9W7NTeErA7DQwN3b|5",
    );
  });
});

describe("call builders", () => {
  test("deposit(token, amount)", () => {
    const call = evmDepositCall({
      contract: MIDRIB,
      token: TOKEN,
      amount: 123_456_789_012_345_678_901n,
    });
    expect(call.address).toBe(MIDRIB);
    expect(encodeFunctionData(call)).toBe(
      "0x03fde2550000000000000000000000005991a2df15a8f6a256d3ec51e99254cd3fb576a9000000000000000000000000000000000000000000000006b14e9f812f366c35",
    );
  });

  test("depositNative() carries the amount as value", () => {
    const call = evmDepositNativeCall({ contract: MIDRIB, amount: 77n });
    expect(call.address).toBe(MIDRIB);
    expect(call.value).toBe(77n);
    expect(encodeFunctionData(call)).toBe("0xdb6b5246");
  });

  test("approve(spender, amount) on the token", () => {
    const call = evmApproveCall({
      token: TOKEN,
      spender: MIDRIB,
      amount: 123_456_789_012_345_678_901n,
    });
    expect(call.address).toBe(TOKEN);
    expect(encodeFunctionData(call)).toBe(
      "0x095ea7b3000000000000000000000000104fbc016f4bb334d775a19e8a6510109ac63e00000000000000000000000000000000000000000000000006b14e9f812f366c35",
    );
  });

  test("withdraw(voucher, signature) submits the voucher's own numbers", () => {
    const signature = hexToBytes(
      "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f401b",
    );
    const call = evmWithdrawCall({
      contract: MIDRIB,
      voucher: {
        account: BOB,
        token: TOKEN,
        amount: "987654321987",
        nonce: 4_759_477_275_222_530_853_130n,
        expiry: 1_760_000_300n,
        signature,
      },
    });
    expect(call.address).toBe(MIDRIB);
    expect(encodeFunctionData(call)).toBe(
      "0x4e5c6e4e0000000000000000000000001d96f2f6bef1202e4ce1ff6dad0c2cb002861d3e0000000000000000000000005991a2df15a8f6a256d3ec51e99254cd3fb576a9000000000000000000000000000000000000000000000000000000e5f4c8f743000000000000000000000000000000000000000000000102030405060708090a0000000000000000000000000000000000000000000000000000000068e7792c00000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000410102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f401b00000000000000000000000000000000000000000000000000000000000000",
    );
  });
});

/** A public client whose `eth_call`s are answered from `answers` by calldata. */
function clientAnswering(answers: Record<string, Hex>) {
  const seen: string[] = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const [{ to, data }] = params as [{ to: string; data: string }];
        seen.push(`${to.toLowerCase()}:${data}`);
        const answer = answers[data];
        if (!answer) throw new Error(`unexpected call ${data}`);
        return answer;
      },
    }),
  });
  return { client, seen };
}

describe("reads", () => {
  test("readEvmFeeRates reads maintenanceBps() and operatorBps()", async () => {
    const { client, seen } = clientAnswering({
      "0x2e673446":
        "0x0000000000000000000000000000000000000000000000000000000000000064",
      "0xc4109253":
        "0x0000000000000000000000000000000000000000000000000000000000000032",
    });
    expect(await readEvmFeeRates(client, MIDRIB)).toEqual({
      maintenanceBps: 100,
      operatorBps: 50,
    });
    expect(seen.sort()).toEqual([
      `${MIDRIB.toLowerCase()}:0x2e673446`,
      `${MIDRIB.toLowerCase()}:0xc4109253`,
    ]);
  });

  test("readTradeBalance reads tradeBalance(holder, token)", async () => {
    const { client, seen } = clientAnswering({
      "0x19d5f0c30000000000000000000000001d96f2f6bef1202e4ce1ff6dad0c2cb002861d3e0000000000000000000000005991a2df15a8f6a256d3ec51e99254cd3fb576a9":
        "0x0000000000000000000000000000000000000000000000000dab6b620af98a49",
    });
    expect(await readTradeBalance(client, MIDRIB, BOB, TOKEN)).toBe(
      984_999_012_345_678_409n,
    );
    expect(seen).toHaveLength(1);
  });
});
