/**
 * MidribV3 (the EVM trade contract) without a framework: its ABI, the
 * write-call parameters for deposits and voucher withdrawals, the canonical
 * withdrawal-request message, and the plain reads (balance, fee rates).
 *
 * The call builders return `{ address, abi, functionName, args, value? }`
 * objects. They go straight into viem's `walletClient.writeContract` or
 * wagmi's `writeContract`, and `encodeFunctionData(call)` turns one into raw
 * calldata. Nothing here signs, sends or waits.
 *
 * Deposits are user-initiated: an ERC-20 `approve` of the contract (when the
 * allowance is short) followed by `deposit(token, amount)`, or a payable
 * `depositNative()` for the native asset, which MidribV3 keys by the
 * `NATIVE_TOKEN_SENTINEL` address. There is no permissionless withdraw: the
 * owner signs `withdrawRequestMessage(...)`, the venue answers with a
 * TEE-signed voucher, and the owner submits `withdraw(voucher, signature)`.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { bytesToHex } from "./signing.js";

/** The MidribV3 functions, events and custom errors this SDK uses. */
export const MIDRIB_V3_ABI = parseAbi([
  "struct WithdrawalVoucher { address account; address token; uint256 amount; uint256 nonce; uint256 expiry; }",
  "function deposit(address _token, uint160 _amount)",
  "function depositNative() payable",
  "function withdraw(WithdrawalVoucher _v, bytes _signature)",
  "function tradeBalance(address holder, address token) view returns (uint256)",
  "function maintenanceBps() view returns (uint16)",
  "function operatorBps() view returns (uint16)",
  "function terminatedAt() view returns (uint256)",
  "function TERMINATION_DELAY() view returns (uint256)",
  "event TokenDeposited(address indexed user, address indexed tokenContract, uint160 amount)",
  "event NetSettled(address indexed user, address indexed tokenContract, int256 delta)",
  "event Withdrawn(address indexed account, address indexed tokenContract, uint256 amount, uint256 nonce)",
  // Custom errors the deposit / withdraw paths can revert with. Listing them
  // lets viem decode a revert into its name and arguments instead of raw
  // bytes. A terminated instance refuses both calls with TERMINATED.
  "error TERMINATED()",
  "error ZERO_AMOUNT()",
  "error MINIMUM_ORDER_AMOUNT(uint160 amount)",
  "error INVALID_SIGNER()",
  "error WITHDRAW_VOUCHER_EXPIRED()",
  "error WITHDRAW_NONCE_ALREADY_USED()",
  "error WITHDRAW_RATE_LIMITED(uint256 cap, uint256 attempted)",
]);

/** The two ERC-20 functions a deposit needs: the allowance check and `approve`. */
export const ERC20_APPROVAL_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/**
 * The exact text a withdrawal request is signed over:
 * `"<network>|<token>|<account>|<amount>"`, with `amount` in the token's base
 * units as a decimal integer.
 *
 * The venue rebuilds this string from the request's own fields and checks the
 * signature against it, so every field must be the one sent in the request,
 * character for character: the token address as the venue's configuration
 * spells it, and the account as the wallet reports it. EVM wallets sign it
 * with EIP-191 `personal_sign`; Solana wallets sign its UTF-8 bytes with raw
 * Ed25519.
 */
export function withdrawRequestMessage(params: {
  network: string;
  token: string;
  account: string;
  amount: bigint;
}): string {
  return `${params.network}|${params.token}|${params.account}|${params.amount.toString()}`;
}

/** `token.approve(spender, amount)` — lets MidribV3 pull a deposit. */
export function evmApproveCall(params: {
  token: Address;
  spender: Address;
  amount: bigint;
}) {
  return {
    address: params.token,
    abi: ERC20_APPROVAL_ABI,
    functionName: "approve" as const,
    args: [params.spender, params.amount] as const,
  };
}

/**
 * `MidribV3.deposit(token, amount)` for an ERC-20. The contract pulls
 * `amount` with `transferFrom`, so the allowance must already cover it.
 */
export function evmDepositCall(params: {
  contract: Address;
  token: Address;
  amount: bigint;
}) {
  return {
    address: params.contract,
    abi: MIDRIB_V3_ABI,
    functionName: "deposit" as const,
    args: [params.token, params.amount] as const,
  };
}

/**
 * `MidribV3.depositNative()` carrying `amount` as call value. Used for the
 * native asset (the sentinel token), which needs no approval.
 */
export function evmDepositNativeCall(params: {
  contract: Address;
  amount: bigint;
}) {
  return {
    address: params.contract,
    abi: MIDRIB_V3_ABI,
    functionName: "depositNative" as const,
    value: params.amount,
  };
}

/**
 * A withdrawal voucher as the venue issues it. The numbers are the ones the
 * TEE signed, so they are submitted exactly as received.
 */
export interface EvmWithdrawalVoucher {
  account: string;
  token: string;
  /** Base units, as the decimal string the venue returns. */
  amount: string;
  nonce: bigint;
  /** Unix time, in seconds, after which the contract refuses the voucher. */
  expiry: bigint;
  /** The TEE's signature over the voucher. */
  signature: Uint8Array;
}

/**
 * `MidribV3.withdraw(voucher, signature)`. Works the same for ERC-20 tokens
 * and the native asset, which the contract pays out as value.
 */
export function evmWithdrawCall(params: {
  contract: Address;
  voucher: EvmWithdrawalVoucher;
}) {
  const v = params.voucher;
  return {
    address: params.contract,
    abi: MIDRIB_V3_ABI,
    functionName: "withdraw" as const,
    args: [
      {
        account: v.account as Address,
        token: v.token as Address,
        amount: BigInt(v.amount),
        nonce: v.nonce,
        expiry: v.expiry,
      },
      bytesToHex(v.signature) as Hex,
    ] as const,
  };
}

/** The name of the MidribV3 custom error `err` carries, if any. */
export function midribRevertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError
    ? reverted.data?.errorName
    : undefined;
}

type ReadClient = Pick<PublicClient, "readContract">;

/** `MidribV3.tradeBalance(holder, token)`: the holder's balance inside the contract. */
export async function readTradeBalance(
  client: ReadClient,
  contract: Address,
  holder: Address,
  token: Address,
): Promise<bigint> {
  return client.readContract({
    address: contract,
    abi: MIDRIB_V3_ABI,
    functionName: "tradeBalance",
    args: [holder, token],
  });
}

/** A trade contract's two fee rates, in basis points of gross volume. */
export interface FeeRates {
  /** The venue maintenance fee, fixed when the contract was created. */
  maintenanceBps: number;
  /** The stack operator's fee, set by the operator admin (0 until set). */
  operatorBps: number;
}

/**
 * Read MidribV3's `maintenanceBps()` and `operatorBps()`. Both apply to every
 * token the contract settles; see `feeForVolume` for how they combine.
 */
export async function readEvmFeeRates(
  client: ReadClient,
  contract: Address,
): Promise<FeeRates> {
  const [maintenanceBps, operatorBps] = await Promise.all([
    client.readContract({
      address: contract,
      abi: MIDRIB_V3_ABI,
      functionName: "maintenanceBps",
    }),
    client.readContract({
      address: contract,
      abi: MIDRIB_V3_ABI,
      functionName: "operatorBps",
    }),
  ]);
  return { maintenanceBps, operatorBps };
}
