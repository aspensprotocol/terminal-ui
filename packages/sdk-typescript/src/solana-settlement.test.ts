/**
 * Solana midrib event and account decoding, against bytes the program's own
 * types produce.
 *
 * Every payload and account image below was printed by a throwaway Rust
 * program depending on arborter `chains/solana/programs/midrib` (feature
 * `no-entrypoint`): `anchor_lang::Event::data()` of `NetSettled` /
 * `Withdrawn` / `OperatorFeeSet` (exactly what `emit!` passes to
 * `sol_log_data`, base64-encoded as the runtime logs it), and
 * `AccountSerialize::try_serialize` of `UserBalance` and `TradingInstance`.
 * The discriminators and the UserBalance PDA come from the same program
 * (`Discriminator::DISCRIMINATOR`, `Pubkey::find_program_address`). The
 * Withdrawn discriminator also equals the constant in arborter's own log
 * parser (`app/chain-solana/src/listener.rs`).
 *
 * Values are chosen so a wrong decoder shows: a negative i128 delta whose
 * magnitude exceeds 2^64, a positive one of 2^64 + 5 (a decoder reading only
 * the low 8 bytes gets 5), u64 fields with all-distinct bytes, and fee rates
 * of 259 and 517 (0x0103 / 0x0205 — a byte swap gives other numbers).
 */

import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";

import {
  NET_SETTLED_EVENT_DISCRIMINATOR,
  TRADING_INSTANCE_ACCOUNT_DISCRIMINATOR,
  USER_BALANCE_ACCOUNT_DISCRIMINATOR,
  WITHDRAWN_EVENT_DISCRIMINATOR,
  decodeMidribEventData,
  decodeTradingInstanceFees,
  decodeUserBalance,
  parseMidribLogs,
  readMidribSolanaEvents,
  readSolanaFeeRates,
  readUserBalance,
  type SolanaEvidenceConnection,
} from "./solana-settlement.js";
import { bytesToHex, hexToBytes } from "./signing.js";

const PROGRAM = "5u8UXwJUDs4y4Dh1cEJYLjGbcYAmBkDUvVmh19r7kMEb";
const USER = "29jGKkZXzh1NJSUzU3kHV3vv3VYi9W7NTeErA7DQwN3b";
const MINT = "6YTUdKqCS5K6NKjypTx1Px6VupDnvdjfnAPm4pTK5r5Y";
const INSTANCE = "BYTMDcHxC9Hrh2FY6a5ztK8Yju29FQt5hkw1schXK5oA";
const USER_BALANCE_PDA = "DFsNfSXkEmCuQ7bsSvwbrFNrrfM3V8F4srVYpBhMkirR";

/** NetSettled { user: USER, mint: MINT, delta: -123456789012345678901234567890 }. */
const NET_SETTLED_NEG =
  "y+rG+mxyc9IRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6lJZYGdudXyDipGYn6attLvCydDX3uXs8/oBCA8WHSQrLvXAsREfjDwJ8BZx/v///w==";
/** NetSettled { user: MINT, mint: USER, delta: 2^64 + 5 }. */
const NET_SETTLED_POS_SWAPPED =
  "y+rG+mxyc9JSWWBnbnV8g4qRmJ+mrbS7wsnQ197l7PP6AQgPFh0kKxEYHyYtNDtCSVBXXmVsc3qBiI+WnaSrsrnAx87V3OPqBQAAAAAAAAABAAAAAAAAAA==";
/** Withdrawn { account: USER, mint: MINT, amount: 0x0102030405060708, nonce: 0x1122334455667788 }. */
const WITHDRAWN =
  "FFnfxsJ82w0RGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dzj6lJZYGdudXyDipGYn6attLvCydDX3uXs8/oBCA8WHSQrCAcGBQQDAgGId2ZVRDMiEQ==";
/** OperatorFeeSet { instance, recipient: USER, bps: 517 } — another midrib event. */
const OPERATOR_FEE_SET =
  "2pNb4ZJPbmGco6qxuL/GzdTb4unw9/4FDBMaISgvNj1ES1JZYGdudREYHyYtNDtCSVBXXmVsc3qBiI+WnaSrsrnAx87V3OPqBQI=";

/** UserBalance { INSTANCE, USER, MINT, deposited: 0x0a0b0c0d0e0f1011, locked: 0x0102030405, bump: 254 }. */
const USER_BALANCE_HEX =
  "0xbbedd09256841dbf9ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e7511181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3ea525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b11100f0e0d0c0b0a0504030201000000fe";
/** TradingInstance { maintenance_bps: 259, operator_bps: 517, … }. */
const TRADING_INSTANCE_HEX =
  "0xb31b1af17dccde3901080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4db030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc0301040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dd0502050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7defd0807060504030201";

function b64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const NEG_EVENT = {
  eventName: "NetSettled",
  args: {
    user: USER,
    mint: MINT,
    delta: -123_456_789_012_345_678_901_234_567_890n,
  },
};
const POS_EVENT = {
  eventName: "NetSettled",
  args: { user: MINT, mint: USER, delta: 18_446_744_073_709_551_621n },
};
const WITHDRAWN_EVENT = {
  eventName: "Withdrawn",
  args: {
    account: USER,
    mint: MINT,
    amount: 72_623_859_790_382_856n,
    nonce: 1_234_605_616_436_508_552n,
  },
};

describe("discriminators", () => {
  test("match the program's", () => {
    expect(bytesToHex(NET_SETTLED_EVENT_DISCRIMINATOR)).toBe(
      "0xcbeac6fa6c7273d2",
    );
    expect(bytesToHex(WITHDRAWN_EVENT_DISCRIMINATOR)).toBe(
      "0x1459dfc6c27cdb0d",
    );
    expect(bytesToHex(USER_BALANCE_ACCOUNT_DISCRIMINATOR)).toBe(
      "0xbbedd09256841dbf",
    );
    expect(bytesToHex(TRADING_INSTANCE_ACCOUNT_DISCRIMINATOR)).toBe(
      "0xb31b1af17dccde39",
    );
  });
});

describe("decodeMidribEventData", () => {
  test("NetSettled with a negative delta wider than 64 bits", () => {
    expect(decodeMidribEventData(b64(NET_SETTLED_NEG))).toEqual(
      NEG_EVENT as never,
    );
  });

  test("NetSettled with a positive delta of 2^64 + 5", () => {
    expect(decodeMidribEventData(b64(NET_SETTLED_POS_SWAPPED))).toEqual(
      POS_EVENT as never,
    );
  });

  test("Withdrawn", () => {
    expect(decodeMidribEventData(b64(WITHDRAWN))).toEqual(
      WITHDRAWN_EVENT as never,
    );
  });

  test("another midrib event is not evidence", () => {
    expect(decodeMidribEventData(b64(OPERATOR_FEE_SET))).toBeNull();
  });

  test("a known discriminator with the wrong length throws", () => {
    const short = b64(NET_SETTLED_NEG).slice(0, 80);
    expect(() => decodeMidribEventData(short)).toThrow(/expected 88/);
  });
});

const OTHER = "Other11111111111111111111111111111111111111";
const EVIL = "Evi1111111111111111111111111111111111111111";

/** A settle transaction's logs, with look-alike data from two other programs. */
const SETTLE_LOGS = [
  "Program ComputeBudget111111111111111111111111111111 invoke [1]",
  "Program ComputeBudget111111111111111111111111111111 success",
  `Program ${PROGRAM} invoke [1]`,
  "Program log: Instruction: SettleBatch",
  `Program data: ${NET_SETTLED_NEG}`,
  `Program ${OTHER} invoke [2]`,
  `Program data: ${WITHDRAWN}`,
  `Program ${OTHER} consumed 100 of 190000 compute units`,
  `Program ${OTHER} success`,
  `Program data: ${OPERATOR_FEE_SET}`,
  `Program data: ${NET_SETTLED_POS_SWAPPED}`,
  `Program ${PROGRAM} consumed 41234 of 200000 compute units`,
  `Program ${PROGRAM} success`,
  `Program ${EVIL} invoke [1]`,
  `Program data: ${NET_SETTLED_NEG}`,
  `Program ${EVIL} success`,
];

describe("parseMidribLogs", () => {
  test("keeps only data the midrib program itself logged", () => {
    expect(parseMidribLogs(SETTLE_LOGS, PROGRAM)).toEqual({
      events: [NEG_EVENT, POS_EVENT],
      truncated: false,
    } as never);
  });

  test("accepts the program id as a PublicKey", () => {
    expect(
      parseMidribLogs(SETTLE_LOGS, new PublicKey(PROGRAM)).events,
    ).toHaveLength(2);
  });

  test("data logged by another program, top-level or nested, is refused", () => {
    expect(
      parseMidribLogs(
        [
          `Program ${EVIL} invoke [1]`,
          `Program data: ${WITHDRAWN}`,
          `Program ${PROGRAM} invoke [2]`,
          `Program ${PROGRAM} success`,
          `Program data: ${NET_SETTLED_NEG}`,
          `Program ${EVIL} success`,
          `Program data: ${NET_SETTLED_NEG}`,
        ],
        PROGRAM,
      ).events,
    ).toEqual([]);
  });

  test("reports a truncated log", () => {
    const out = parseMidribLogs(
      [
        `Program ${PROGRAM} invoke [1]`,
        `Program data: ${WITHDRAWN}`,
        "Log truncated",
      ],
      PROGRAM,
    );
    expect(out).toEqual({
      events: [WITHDRAWN_EVENT],
      truncated: true,
    } as never);
  });

  test("an exit that does not match the running program throws", () => {
    expect(() =>
      parseMidribLogs(
        [`Program ${PROGRAM} invoke [1]`, `Program ${OTHER} success`],
        PROGRAM,
      ),
    ).toThrow(/exits/);
  });
});

/** A connection serving `txs` for the UserBalance PDA, newest signature first. */
function fakeConnection(
  txs: Array<{
    signature: string;
    slot: number;
    err?: unknown;
    logs: string[] | null;
  }>,
) {
  const sigCalls: Array<{
    address: string;
    before?: string;
    until?: string;
    limit?: number;
  }> = [];
  const connection: SolanaEvidenceConnection = {
    async getSignaturesForAddress(address, options) {
      sigCalls.push({ address: address.toBase58(), ...options });
      let list = txs;
      if (options?.until) {
        list = list.slice(
          0,
          list.findIndex((t) => t.signature === options.until),
        );
      }
      if (options?.before) {
        list = list.slice(
          list.findIndex((t) => t.signature === options.before) + 1,
        );
      }
      return list.slice(0, options?.limit ?? 1000).map((t) => ({
        signature: t.signature,
        slot: t.slot,
        err: (t.err ?? null) as never,
        memo: null,
      }));
    },
    async getTransaction(signature, config) {
      expect(config.maxSupportedTransactionVersion).toBe(0);
      const t = txs.find((x) => x.signature === signature);
      if (!t) return null;
      return {
        slot: t.slot,
        blockTime: 1_700_000_000 + t.slot,
        meta: { err: t.err ?? null, logMessages: t.logs },
      };
    },
  };
  return { connection, sigCalls };
}

const READ_OPTS = {
  programId: new PublicKey(PROGRAM),
  instance: new PublicKey(INSTANCE),
  user: new PublicKey(USER),
  mint: new PublicKey(MINT),
};

describe("readMidribSolanaEvents", () => {
  test("pages the UserBalance PDA's signatures and returns the user's events oldest first", async () => {
    const withdrawTx = [
      `Program ${PROGRAM} invoke [1]`,
      `Program data: ${WITHDRAWN}`,
      `Program ${PROGRAM} success`,
    ];
    const { connection, sigCalls } = fakeConnection([
      { signature: "sig4", slot: 40, logs: withdrawTx },
      {
        signature: "sig3",
        slot: 30,
        err: { InstructionError: [0, "Custom"] },
        logs: withdrawTx,
      },
      { signature: "sig2", slot: 20, logs: SETTLE_LOGS },
      { signature: "sig1", slot: 10, logs: withdrawTx },
    ]);
    const scan = await readMidribSolanaEvents(connection, {
      ...READ_OPTS,
      until: "sig1",
      pageSize: 2,
    });
    expect(sigCalls.map((c) => c.address)).toEqual([
      USER_BALANCE_PDA,
      USER_BALANCE_PDA,
    ]);
    expect(sigCalls.map((c) => [c.before, c.until, c.limit])).toEqual([
      [undefined, "sig1", 2],
      ["sig3", "sig1", 2],
    ]);
    // sig2's positive delta belongs to another account (user/mint swapped) and
    // is dropped; sig3 failed; sig1 is the previous read's high-water mark.
    expect(
      scan.events.map((e) => [e.signature, e.slot, e.eventIndex, e.eventName]),
    ).toEqual([
      ["sig2", 20, 0, "NetSettled"],
      ["sig4", 40, 0, "Withdrawn"],
    ]);
    expect(scan.events[0]).toMatchObject({
      ...NEG_EVENT,
      blockTime: 1_700_000_020,
    });
    expect(scan.newestSignature).toBe("sig4");
    expect(scan.incomplete).toEqual([]);
  });

  test("never fetches a failed transaction, and skips one whose meta reports failure", async () => {
    const ok = [
      `Program ${PROGRAM} invoke [1]`,
      `Program data: ${WITHDRAWN}`,
      `Program ${PROGRAM} success`,
    ];
    const { connection } = fakeConnection([
      { signature: "c", slot: 3, logs: ok },
      {
        signature: "b",
        slot: 2,
        err: { InstructionError: [0, "Custom"] },
        logs: ok,
      },
      { signature: "a", slot: 1, logs: ok },
    ]);
    const fetched: string[] = [];
    const inner = connection.getTransaction.bind(connection);
    connection.getTransaction = async (signature, config) => {
      fetched.push(signature);
      const tx = await inner(signature, config);
      // The signature list says "a" succeeded, but its meta says otherwise.
      return signature === "a" && tx
        ? {
            ...tx,
            meta: { ...tx.meta!, err: { InstructionError: [0, "Custom"] } },
          }
        : tx;
    };
    const scan = await readMidribSolanaEvents(connection, READ_OPTS);
    expect(fetched).toEqual(["a", "c"]);
    expect(scan.events.map((e) => e.signature)).toEqual(["c"]);
  });

  test("flags transactions with truncated or missing logs", async () => {
    const { connection } = fakeConnection([
      { signature: "b", slot: 2, logs: null },
      {
        signature: "a",
        slot: 1,
        logs: [`Program ${PROGRAM} invoke [1]`, "Log truncated"],
      },
    ]);
    const scan = await readMidribSolanaEvents(connection, READ_OPTS);
    expect(scan.incomplete).toEqual(["a", "b"]);
  });

  test("a transaction the RPC cannot return rejects the read", async () => {
    const { connection } = fakeConnection([
      { signature: "a", slot: 1, logs: [] },
    ]);
    connection.getTransaction = async () => null;
    await expect(readMidribSolanaEvents(connection, READ_OPTS)).rejects.toThrow(
      /not found/,
    );
  });

  test("nothing new keeps the previous high-water mark", async () => {
    const { connection } = fakeConnection([
      { signature: "a", slot: 1, logs: [] },
    ]);
    const scan = await readMidribSolanaEvents(connection, {
      ...READ_OPTS,
      until: "a",
    });
    expect(scan).toEqual({ events: [], newestSignature: "a", incomplete: [] });
  });
});

describe("UserBalance", () => {
  test("decodes deposited, locked and the key fields", () => {
    expect(decodeUserBalance(hexToBytes(USER_BALANCE_HEX))).toEqual({
      instance: INSTANCE,
      user: USER,
      mint: MINT,
      deposited: 723_685_415_333_072_913n,
      locked: 4_328_719_365n,
      bump: 254,
    });
  });

  test("refuses another account type", () => {
    expect(() => decodeUserBalance(hexToBytes(TRADING_INSTANCE_HEX))).toThrow(
      /discriminator/,
    );
  });

  test("readUserBalance reads the PDA and checks its owner and fields", async () => {
    const data = hexToBytes(USER_BALANCE_HEX);
    const seen: string[] = [];
    const ok = await readUserBalance(
      {
        async getAccountInfo(address) {
          seen.push(address.toBase58());
          return { data, owner: new PublicKey(PROGRAM) };
        },
      },
      READ_OPTS,
    );
    expect(seen).toEqual([USER_BALANCE_PDA]);
    expect(ok?.deposited).toBe(723_685_415_333_072_913n);

    expect(
      await readUserBalance({ getAccountInfo: async () => null }, READ_OPTS),
    ).toBeNull();
    await expect(
      readUserBalance(
        { getAccountInfo: async () => ({ data, owner: new PublicKey(MINT) }) },
        READ_OPTS,
      ),
    ).rejects.toThrow(/owned by/);
    await expect(
      readUserBalance(
        {
          getAccountInfo: async () => ({ data, owner: new PublicKey(PROGRAM) }),
        },
        { ...READ_OPTS, user: new PublicKey(MINT) },
      ),
    ).rejects.toThrow(/different instance, user or mint/);
  });
});

describe("TradingInstance fee rates", () => {
  test("decodes maintenance_bps and operator_bps", () => {
    expect(decodeTradingInstanceFees(hexToBytes(TRADING_INSTANCE_HEX))).toEqual(
      {
        maintenanceBps: 259,
        operatorBps: 517,
      },
    );
  });

  test("refuses another account type", () => {
    expect(() =>
      decodeTradingInstanceFees(hexToBytes(USER_BALANCE_HEX)),
    ).toThrow(/discriminator/);
  });

  test("readSolanaFeeRates reads the instance account", async () => {
    const data = hexToBytes(TRADING_INSTANCE_HEX);
    const rates = await readSolanaFeeRates(
      {
        async getAccountInfo(address) {
          expect(address.toBase58()).toBe(INSTANCE);
          return { data, owner: new PublicKey(PROGRAM) };
        },
      },
      { programId: new PublicKey(PROGRAM), instance: new PublicKey(INSTANCE) },
    );
    expect(rates).toEqual({ maintenanceBps: 259, operatorBps: 517 });
  });
});
