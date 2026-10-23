/**
 * MidribV3 on Tron: the deposit, native deposit and voucher withdraw, sent
 * as native Tron transactions by {@link sendTronTx}.
 *
 * The calldata is the EVM path's, encoded from the same `MIDRIB_V3_ABI` call
 * builders (`evmApproveCall`, `evmDepositCall`, `evmDepositNativeCall`,
 * `evmWithdrawCall`): the contract is the same code on the TVM. Only the
 * transport differs. Every function resolves only when each transaction it
 * sends has a `SUCCESS` receipt, and throws a `TronTxError` otherwise.
 *
 * Accounts and contracts are `0x` hex here, as everywhere inside the venue;
 * convert a `T…` address with `tronToHex` first.
 */

import { encodeFunctionData, type Address, type PublicClient } from "viem";

import {
  ERC20_APPROVAL_ABI,
  evmApproveCall,
  evmDepositCall,
  evmDepositNativeCall,
  evmWithdrawCall,
  type EvmWithdrawalVoucher,
} from "./midrib-evm.js";
import { isNativeToken } from "./native.js";
import type { SigningAdapter } from "./signing.js";
import {
  sendTronTx,
  tronPublicClient,
  type TronNode,
  type TronReceipt,
} from "./tron-client.js";

// Fee limits cap the energy a transaction may burn, in sun (energy price 100
// sun). Each is 3 x the energy measured for that call on Nile x 100 sun.
// Bandwidth is burned on top of the limit. Mainnet USDT carries a dynamic
// energy factor (Nile's copy has none), so on mainnet the USDT legs (the
// deposit's transferFrom and a USDT voucher withdraw) can cost several times
// the Nile energy and exceed these limits. That surfaces as an OUT_OF_ENERGY
// error naming the account, never as a false success.

/** USDT `approve`: 3 x 22,688 energy x 100 sun. */
export const TRON_APPROVE_FEE_LIMIT_SUN = 3n * 22_688n * 100n;
/** MidribV3 `deposit(token, amount)` of USDT: 3 x 87,602 energy x 100 sun. */
export const TRON_DEPOSIT_FEE_LIMIT_SUN = 3n * 87_602n * 100n;
/**
 * MidribV3 `depositNative()` into a new balance slot: 3 x 32,798 energy x
 * 100 sun.
 */
export const TRON_DEPOSIT_NATIVE_FEE_LIMIT_SUN = 3n * 32_798n * 100n;
/**
 * MidribV3 voucher `withdraw`, the costliest measured case (USDT through the
 * Tron payout override; a TRX payout to a never-activated address measured
 * 83,435): 3 x 84,386 energy x 100 sun.
 */
export const TRON_WITHDRAW_FEE_LIMIT_SUN = 3n * 84_386n * 100n;

/**
 * TRX a Tron withdraw needs before a voucher is requested, in sun: the
 * costliest measured voucher withdraw on Nile (84,386 energy x 100 sun +
 * 604,000 sun of bandwidth), the same floor the Rust SDK checks. A voucher
 * places a hold, so one the wallet cannot pay to submit would strand it until
 * expiry.
 */
export const TRON_MIN_TRX_FOR_WITHDRAW_SUN = 84_386n * 100n + 604_000n;

/**
 * Refuse a Tron withdraw the wallet cannot pay for, before anything is signed
 * or a voucher requested: throws when `owner` holds less than
 * {@link TRON_MIN_TRX_FOR_WITHDRAW_SUN}. Call it first, ahead of
 * `signWithdrawRequest` and the voucher request, so a short wallet fails with
 * nothing held.
 *
 * The balance is read over the node's `/jsonrpc` (`reads`, by default a
 * client over `node`); a read that fails throws too.
 */
export async function assertTronWithdrawTrx(params: {
  node: TronNode;
  /** The withdrawing account, `0x` hex. */
  owner: string;
  reads?: PublicClient;
}): Promise<void> {
  const reads = params.reads ?? tronPublicClient(params.node);
  const owner = params.owner.toLowerCase();
  const trx = await reads.getBalance({ address: owner as Address });
  if (trx < TRON_MIN_TRX_FOR_WITHDRAW_SUN) {
    throw new Error(
      `insufficient TRX: ${owner} holds ${trx} sun, and a voucher withdraw ` +
        `burns up to about ${TRON_MIN_TRX_FOR_WITHDRAW_SUN} sun. Fund it with ` +
        `TRX first. (No voucher requested: your withdrawable balance is ` +
        `untouched.)`,
    );
  }
}

/** Who sends, and through which node. */
export interface TronSender {
  node: TronNode;
  /** Signs each transaction; must implement `signTronTransaction`. */
  adapter: SigningAdapter;
  /** The sending account, `0x` hex. */
  owner: string;
  /** Between two looks at a sent transaction; default 1 s. */
  pollIntervalMs?: number;
}

/**
 * Deposit a TRC-20 token (USDT): `approve(contract, amount)` on the token
 * when the allowance is short of `amount`, which must succeed first, then
 * `MidribV3.deposit(token, amount)`.
 *
 * The allowance is read over the node's `/jsonrpc` (`reads`, by default a
 * client over `node`). The native asset goes through
 * {@link tronDepositNative} instead, and is refused here.
 */
export async function tronDeposit(
  params: TronSender & {
    /** The MidribV3 instance, `0x` hex. */
    contract: string;
    /** The token, `0x` hex. */
    token: string;
    /** Base units. */
    amount: bigint;
    reads?: Pick<PublicClient, "readContract">;
  },
): Promise<{ approve?: TronReceipt; deposit: TronReceipt }> {
  const { contract, token, amount } = params;
  if (isNativeToken(token)) {
    throw new Error(
      "the native asset (TRX) is deposited with tronDepositNative, not deposit",
    );
  }
  if (amount <= 0n) throw new Error(`deposit amount ${amount} is not positive`);
  const reads = params.reads ?? tronPublicClient(params.node);
  const allowance = (await reads.readContract({
    address: token as Address,
    abi: ERC20_APPROVAL_ABI,
    functionName: "allowance",
    args: [params.owner as Address, contract as Address],
  })) as bigint;

  let approve: TronReceipt | undefined;
  if (allowance < amount) {
    approve = await sendTronTx({
      ...sendOpts(params),
      contract: token,
      data: encodeFunctionData(
        evmApproveCall({
          token: token as Address,
          spender: contract as Address,
          amount,
        }),
      ),
      callValueSun: 0n,
      feeLimitSun: TRON_APPROVE_FEE_LIMIT_SUN,
    });
  }

  const deposit = await sendTronTx({
    ...sendOpts(params),
    contract,
    data: encodeFunctionData(
      evmDepositCall({
        contract: contract as Address,
        token: token as Address,
        amount,
      }),
    ),
    callValueSun: 0n,
    feeLimitSun: TRON_DEPOSIT_FEE_LIMIT_SUN,
  });
  return { approve, deposit };
}

/**
 * Deposit TRX: `MidribV3.depositNative()` carrying `amount` sun as the
 * call value. No approve.
 */
export async function tronDepositNative(
  params: TronSender & {
    /** The MidribV3 instance, `0x` hex. */
    contract: string;
    /** Sun. */
    amount: bigint;
  },
): Promise<TronReceipt> {
  if (params.amount <= 0n) {
    throw new Error(`deposit amount ${params.amount} is not positive`);
  }
  return sendTronTx({
    ...sendOpts(params),
    contract: params.contract,
    data: encodeFunctionData(
      evmDepositNativeCall({
        contract: params.contract as Address,
        amount: params.amount,
      }),
    ),
    callValueSun: params.amount,
    feeLimitSun: TRON_DEPOSIT_NATIVE_FEE_LIMIT_SUN,
  });
}

/**
 * Redeem a venue-signed withdrawal voucher: `MidribV3.withdraw(voucher,
 * signature)`, for USDT and TRX alike. The voucher's fields go on chain
 * exactly as the venue issued them.
 */
export async function tronWithdraw(
  params: TronSender & {
    /** The MidribV3 instance, `0x` hex. */
    contract: string;
    voucher: EvmWithdrawalVoucher;
  },
): Promise<TronReceipt> {
  return sendTronTx({
    ...sendOpts(params),
    contract: params.contract,
    data: encodeFunctionData(
      evmWithdrawCall({
        contract: params.contract as Address,
        voucher: params.voucher,
      }),
    ),
    callValueSun: 0n,
    feeLimitSun: TRON_WITHDRAW_FEE_LIMIT_SUN,
  });
}

function sendOpts(p: TronSender) {
  return {
    node: p.node,
    adapter: p.adapter,
    owner: p.owner,
    pollIntervalMs: p.pollIntervalMs,
  };
}
