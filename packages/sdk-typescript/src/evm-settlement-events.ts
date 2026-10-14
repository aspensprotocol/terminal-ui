/**
 * Settlement evidence from MidribV3 logs.
 *
 * Three events move an account's `tradeBalance`, and all three index the
 * account as their first topic:
 *
 *   - `TokenDeposited(user, tokenContract, amount)` — a deposit.
 *   - `NetSettled(user, tokenContract, delta)` — one per (account, token) per
 *     `settleBatch`, carrying the signed net change after fees. It is omitted
 *     when an account's net is zero, except that a taker whose trades netted
 *     to zero still receives a negative delta equal to its fee share.
 *   - `Withdrawn(account, tokenContract, amount, nonce)` — a voucher
 *     withdrawal.
 *
 * `readMidribEvents` fetches all three for one account in one `eth_getLogs`
 * per block chunk, filtering on that first topic, and decodes them.
 */

import {
  decodeEventLog,
  getAddress,
  pad,
  toEventSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { MIDRIB_V3_ABI } from "./midrib-evm.js";

const SETTLEMENT_EVENTS_ABI = MIDRIB_V3_ABI.filter(
  (item) =>
    item.type === "event" &&
    (item.name === "TokenDeposited" ||
      item.name === "NetSettled" ||
      item.name === "Withdrawn"),
);

/** topic0 of `NetSettled(address,address,int256)`. */
export const NET_SETTLED_TOPIC: Hex = toEventSelector(
  "NetSettled(address,address,int256)",
);
/** topic0 of `TokenDeposited(address,address,uint160)`. */
export const TOKEN_DEPOSITED_TOPIC: Hex = toEventSelector(
  "TokenDeposited(address,address,uint160)",
);
/** topic0 of `Withdrawn(address,address,uint256,uint256)`. */
export const WITHDRAWN_TOPIC: Hex = toEventSelector(
  "Withdrawn(address,address,uint256,uint256)",
);

/** A decoded MidribV3 balance event. Addresses are EIP-55 checksummed. */
export type MidribEvmEvent =
  | {
      eventName: "NetSettled";
      args: { user: Address; tokenContract: Address; delta: bigint };
    }
  | {
      eventName: "TokenDeposited";
      args: { user: Address; tokenContract: Address; amount: bigint };
    }
  | {
      eventName: "Withdrawn";
      args: {
        account: Address;
        tokenContract: Address;
        amount: bigint;
        nonce: bigint;
      };
    };

/** A decoded event with its position on chain. */
export type MidribEvmLog = MidribEvmEvent & {
  /** The contract that emitted it. */
  address: Address;
  blockNumber: bigint;
  txHash: Hex;
  /** Index of the log within its block. */
  logIndex: number;
};

/** The parts of a log the decoder reads. */
export interface RawEvmLog {
  topics: readonly Hex[];
  data: Hex;
}

/**
 * Decode one MidribV3 log into `NetSettled`, `TokenDeposited` or `Withdrawn`.
 * Returns `null` for any other topic0; throws if topic0 matches but the log
 * does not decode as that event.
 */
export function decodeMidribLog(log: RawEvmLog): MidribEvmEvent | null {
  const topic0 = log.topics[0]?.toLowerCase();
  if (
    topic0 !== NET_SETTLED_TOPIC &&
    topic0 !== TOKEN_DEPOSITED_TOPIC &&
    topic0 !== WITHDRAWN_TOPIC
  ) {
    return null;
  }
  const decoded = decodeEventLog({
    abi: SETTLEMENT_EVENTS_ABI,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
    strict: true,
  });
  switch (decoded.eventName) {
    case "NetSettled":
      return {
        eventName: "NetSettled",
        args: {
          user: getAddress(decoded.args.user),
          tokenContract: getAddress(decoded.args.tokenContract),
          delta: decoded.args.delta,
        },
      };
    case "TokenDeposited":
      return {
        eventName: "TokenDeposited",
        args: {
          user: getAddress(decoded.args.user),
          tokenContract: getAddress(decoded.args.tokenContract),
          amount: decoded.args.amount,
        },
      };
    case "Withdrawn":
      return {
        eventName: "Withdrawn",
        args: {
          account: getAddress(decoded.args.account),
          tokenContract: getAddress(decoded.args.tokenContract),
          amount: decoded.args.amount,
          nonce: decoded.args.nonce,
        },
      };
    default:
      return null;
  }
}

/** Default block span of one `eth_getLogs` call; public RPCs cap the range. */
export const DEFAULT_LOG_CHUNK_BLOCKS = 2000n;

export interface ReadMidribEventsOptions {
  /** The MidribV3 instance. */
  contract: Address;
  /** The account whose balance events to fetch (the first indexed topic). */
  account: Address;
  /** First block, inclusive. */
  fromBlock: bigint;
  /** Last block, inclusive. */
  toBlock: bigint;
  /** Blocks per `eth_getLogs` call. Defaults to `DEFAULT_LOG_CHUNK_BLOCKS`. */
  chunkSize?: bigint;
}

interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | null;
  transactionHash: Hex | null;
  logIndex: Hex | null;
  removed?: boolean;
}

function toHexQuantity(n: bigint): Hex {
  return `0x${n.toString(16)}`;
}

function accountOf(event: MidribEvmEvent): Address {
  return event.eventName === "Withdrawn" ? event.args.account : event.args.user;
}

/**
 * Fetch and decode `account`'s `NetSettled`, `TokenDeposited` and
 * `Withdrawn` logs from `contract` over `[fromBlock, toBlock]`, in chunks of
 * `chunkSize` blocks, in chain order.
 *
 * Chunks are fetched one after another; a failing call rejects the whole
 * read, so the caller retries the range rather than keeping a partial scan.
 * Logs flagged `removed` (reorged out) are dropped. A log from another
 * contract or for another account means the RPC ignored the filter, and is
 * refused with an error rather than skipped.
 */
export async function readMidribEvents(
  client: Pick<PublicClient, "request">,
  opts: ReadMidribEventsOptions,
): Promise<MidribEvmLog[]> {
  const chunk = opts.chunkSize ?? DEFAULT_LOG_CHUNK_BLOCKS;
  if (chunk <= 0n) throw new RangeError("chunkSize must be positive");
  if (opts.fromBlock < 0n || opts.toBlock < opts.fromBlock) {
    throw new RangeError(
      `invalid block range ${opts.fromBlock}..${opts.toBlock}`,
    );
  }
  const contract = getAddress(opts.contract);
  const account = getAddress(opts.account);
  const accountTopic = pad(account.toLowerCase() as Hex, { size: 32 });

  const out: MidribEvmLog[] = [];
  for (let from = opts.fromBlock; from <= opts.toBlock; from += chunk) {
    const to =
      from + chunk - 1n < opts.toBlock ? from + chunk - 1n : opts.toBlock;
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: contract,
          fromBlock: toHexQuantity(from),
          toBlock: toHexQuantity(to),
          topics: [
            [NET_SETTLED_TOPIC, TOKEN_DEPOSITED_TOPIC, WITHDRAWN_TOPIC],
            accountTopic,
          ],
        },
      ],
    })) as RpcLog[];

    for (const log of logs) {
      if (log.removed) continue;
      if (getAddress(log.address) !== contract) {
        throw new Error(
          `eth_getLogs returned a log from ${log.address}, not ${contract}`,
        );
      }
      const event = decodeMidribLog(log);
      if (!event) {
        throw new Error(
          `eth_getLogs returned a log with unrequested topic0 ${log.topics[0]}`,
        );
      }
      if (accountOf(event) !== account) {
        throw new Error(
          `eth_getLogs returned a ${event.eventName} for ${accountOf(event)}, not ${account}`,
        );
      }
      if (
        log.blockNumber === null ||
        log.transactionHash === null ||
        log.logIndex === null
      ) {
        throw new Error("eth_getLogs returned a pending log");
      }
      out.push({
        ...event,
        address: contract,
        blockNumber: BigInt(log.blockNumber),
        txHash: log.transactionHash,
        logIndex: Number(BigInt(log.logIndex)),
      });
    }
  }
  out.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
  return out;
}
