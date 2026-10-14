/**
 * MidribV3 settlement-event decoding, against logs a real MidribV3 emitted.
 *
 * Every topic and data word below was recorded (`vm.recordLogs`) from a
 * MidribV3 instance built from arborter `chains/evm/src`, in a throwaway
 * forge test reusing `MidribV3Test`'s setup: alice deposits
 * 123456789012345678901, a `settleBatch` with gross volume
 * 1000000000000000199 at 100 + 50 bps moves -1000000000000000199 from alice
 * and +985000000000000198 to bob, and bob withdraws 987654321987 with voucher
 * nonce 0x0102030405060708090a. The three topic0 values also equal
 * `cast sig-event` of the MidribEvents.sol declarations.
 */

import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";

import {
  NET_SETTLED_TOPIC,
  TOKEN_DEPOSITED_TOPIC,
  WITHDRAWN_TOPIC,
  decodeMidribLog,
  readMidribEvents,
} from "./evm-settlement-events.js";

const MIDRIB = "0x104fBc016F4bb334D775a19E8A6510109AC63E00";
const TOKEN = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9";
const ALICE = "0x328809Bc894f92807417D2dAD6b7C998c1aFdac6";
const BOB = "0x1D96F2f6BeF1202E4Ce1Ff6Dad0c2CB002861d3e";

const T_DEPOSITED =
  "0xf252e7564622d27c64805f4295d4aed7999599ad484da4eaa1377fc14df9f1d5";
const T_NET_SETTLED =
  "0xcb92bc64cc5c68703b92c9fcf4b3a37a69be04873e614837f8aeacfa8589e8f5";
const T_WITHDRAWN =
  "0x91fb9d98b786c57d74c099ccd2beca1739e9f6a81fb49001ca465c4b7591bbe2";
const ALICE_TOPIC =
  "0x000000000000000000000000328809bc894f92807417d2dad6b7c998c1afdac6";
const BOB_TOPIC =
  "0x0000000000000000000000001d96f2f6bef1202e4ce1ff6dad0c2cb002861d3e";
const TOKEN_TOPIC =
  "0x0000000000000000000000005991a2df15a8f6a256d3ec51e99254cd3fb576a9";

const DEPOSIT_LOG = {
  topics: [T_DEPOSITED, ALICE_TOPIC, TOKEN_TOPIC] as Hex[],
  data: "0x000000000000000000000000000000000000000000000006b14e9f812f366c35" as Hex,
};
const SETTLED_ALICE_LOG = {
  topics: [T_NET_SETTLED, ALICE_TOPIC, TOKEN_TOPIC] as Hex[],
  data: "0xfffffffffffffffffffffffffffffffffffffffffffffffff21f494c589bff39" as Hex,
};
const SETTLED_BOB_LOG = {
  topics: [T_NET_SETTLED, BOB_TOPIC, TOKEN_TOPIC] as Hex[],
  data: "0x0000000000000000000000000000000000000000000000000dab6c47ffc280c6" as Hex,
};
const WITHDRAWN_LOG = {
  topics: [T_WITHDRAWN, BOB_TOPIC, TOKEN_TOPIC] as Hex[],
  data: "0x000000000000000000000000000000000000000000000000000000e5f4c8f743000000000000000000000000000000000000000000000102030405060708090a" as Hex,
};

describe("topics", () => {
  test("match the contract's emitted topic0s", () => {
    expect(NET_SETTLED_TOPIC).toBe(T_NET_SETTLED);
    expect(TOKEN_DEPOSITED_TOPIC).toBe(T_DEPOSITED);
    expect(WITHDRAWN_TOPIC).toBe(T_WITHDRAWN);
  });
});

describe("decodeMidribLog", () => {
  test("TokenDeposited", () => {
    expect(decodeMidribLog(DEPOSIT_LOG)).toEqual({
      eventName: "TokenDeposited",
      args: {
        user: ALICE,
        tokenContract: TOKEN,
        amount: 123_456_789_012_345_678_901n,
      },
    });
  });

  test("NetSettled with a negative delta", () => {
    expect(decodeMidribLog(SETTLED_ALICE_LOG)).toEqual({
      eventName: "NetSettled",
      args: {
        user: ALICE,
        tokenContract: TOKEN,
        delta: -1_000_000_000_000_000_199n,
      },
    });
  });

  test("NetSettled with a positive delta", () => {
    expect(decodeMidribLog(SETTLED_BOB_LOG)).toEqual({
      eventName: "NetSettled",
      args: {
        user: BOB,
        tokenContract: TOKEN,
        delta: 985_000_000_000_000_198n,
      },
    });
  });

  test("Withdrawn", () => {
    expect(decodeMidribLog(WITHDRAWN_LOG)).toEqual({
      eventName: "Withdrawn",
      args: {
        account: BOB,
        tokenContract: TOKEN,
        amount: 987_654_321_987n,
        nonce: 4_759_477_275_222_530_853_130n,
      },
    });
  });

  test("another event is not evidence", () => {
    // ERC-20 Transfer(address,address,uint256).
    expect(
      decodeMidribLog({
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          ALICE_TOPIC,
          TOKEN_TOPIC,
        ],
        data: DEPOSIT_LOG.data,
      }),
    ).toBeNull();
  });

  test("a matching topic0 with a malformed body throws", () => {
    expect(() =>
      decodeMidribLog({ topics: [T_NET_SETTLED, ALICE_TOPIC], data: "0x" }),
    ).toThrow();
  });
});

interface Call {
  fromBlock: string;
  toBlock: string;
  address: string;
  topics: unknown;
}

/** An `eth_getLogs` endpoint serving `logs` (each tagged with its block). */
function logsEndpoint(logs: Array<Record<string, unknown>>) {
  const calls: Call[] = [];
  const client = {
    async request(args: { method: string; params: unknown }) {
      if (args.method !== "eth_getLogs") throw new Error(args.method);
      const [filter] = args.params as [Call];
      calls.push(filter);
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      return logs.filter((l) => {
        const b = BigInt(l.blockNumber as string);
        return b >= from && b <= to;
      });
    },
  };
  return { client: client as never, calls };
}

function rpcLog(
  log: { topics: Hex[]; data: Hex },
  block: number,
  logIndex: number,
  extra: Record<string, unknown> = {},
) {
  return {
    address: MIDRIB.toLowerCase(),
    topics: log.topics,
    data: log.data,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${"ab".repeat(30)}${block.toString(16).padStart(4, "0")}`,
    logIndex: `0x${logIndex.toString(16)}`,
    ...extra,
  };
}

describe("readMidribEvents", () => {
  test("fetches 2000-block chunks filtered on the account topic, in chain order", async () => {
    const { client, calls } = logsEndpoint([
      rpcLog(SETTLED_ALICE_LOG, 4100, 3),
      rpcLog(DEPOSIT_LOG, 10, 1),
      rpcLog(SETTLED_ALICE_LOG, 4100, 1),
    ]);
    const out = await readMidribEvents(client, {
      contract: MIDRIB,
      account: ALICE,
      fromBlock: 0n,
      toBlock: 4500n,
    });
    expect(calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      ["0x0", "0x7cf"],
      ["0x7d0", "0xf9f"],
      ["0xfa0", "0x1194"],
    ]);
    for (const c of calls) {
      expect(c.address).toBe(MIDRIB);
      expect(c.topics).toEqual([
        [T_NET_SETTLED, T_DEPOSITED, T_WITHDRAWN],
        ALICE_TOPIC,
      ]);
    }
    expect(out.map((e) => [e.eventName, e.blockNumber, e.logIndex])).toEqual([
      ["TokenDeposited", 10n, 1],
      ["NetSettled", 4100n, 1],
      ["NetSettled", 4100n, 3],
    ]);
    expect(out[1].address).toBe(MIDRIB);
    expect(out[1].txHash).toBe(`0x${"ab".repeat(30)}1004`);
  });

  test("honours a custom chunk size and a range smaller than one chunk", async () => {
    const { client, calls } = logsEndpoint([]);
    await readMidribEvents(client, {
      contract: MIDRIB,
      account: BOB,
      fromBlock: 100n,
      toBlock: 349n,
      chunkSize: 100n,
    });
    expect(calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      ["0x64", "0xc7"],
      ["0xc8", "0x12b"],
      ["0x12c", "0x15d"],
    ]);
    const one = logsEndpoint([]);
    await readMidribEvents(one.client, {
      contract: MIDRIB,
      account: BOB,
      fromBlock: 7n,
      toBlock: 7n,
    });
    expect(one.calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      ["0x7", "0x7"],
    ]);
  });

  test("drops removed logs", async () => {
    const { client } = logsEndpoint([
      rpcLog(WITHDRAWN_LOG, 5, 0, { removed: true }),
      rpcLog(WITHDRAWN_LOG, 6, 0),
    ]);
    const out = await readMidribEvents(client, {
      contract: MIDRIB,
      account: BOB,
      fromBlock: 0n,
      toBlock: 10n,
    });
    expect(out.map((e) => e.blockNumber)).toEqual([6n]);
  });

  test("refuses a log for another account", async () => {
    const { client } = logsEndpoint([rpcLog(SETTLED_BOB_LOG, 5, 0)]);
    await expect(
      readMidribEvents(client, {
        contract: MIDRIB,
        account: ALICE,
        fromBlock: 0n,
        toBlock: 10n,
      }),
    ).rejects.toThrow(/NetSettled for 0x1D96/);
  });

  test("refuses a log from another contract", async () => {
    const { client } = logsEndpoint([
      { ...rpcLog(SETTLED_ALICE_LOG, 5, 0), address: TOKEN },
    ]);
    await expect(
      readMidribEvents(client, {
        contract: MIDRIB,
        account: ALICE,
        fromBlock: 0n,
        toBlock: 10n,
      }),
    ).rejects.toThrow(/not 0x104f/);
  });

  test("refuses an empty or inverted range and a non-positive chunk", async () => {
    const { client } = logsEndpoint([]);
    const base = { contract: MIDRIB, account: ALICE } as const;
    await expect(
      readMidribEvents(client, { ...base, fromBlock: 5n, toBlock: 4n }),
    ).rejects.toThrow(RangeError);
    await expect(
      readMidribEvents(client, {
        ...base,
        fromBlock: 0n,
        toBlock: 4n,
        chunkSize: 0n,
      }),
    ).rejects.toThrow(RangeError);
  });
});
