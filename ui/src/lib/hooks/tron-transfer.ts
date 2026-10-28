/**
 * Tron deposits and withdrawals, as sequences over the SDK's Tron calls.
 *
 * The SDK functions are passed in (`TronTransferDeps`, defaulting to the
 * real ones) so the order of the steps tests without a node or a wallet.
 * The order is what protects the user:
 * - A withdraw checks the account holds the TRX to submit the voucher
 *   BEFORE it signs anything or asks for a voucher: a voucher places a hold,
 *   and one the wallet cannot pay to submit would strand it until expiry.
 * - The request is signed by `signWithdrawRequest` with the chain's own
 *   architecture, which on Tron signs the text under the TRON message
 *   prefix and never EIP-191.
 * - The voucher's amount must be the amount requested; a voucher for any
 *   other figure is not submitted.
 */

import {
  assertTronWithdrawTrx,
  isNativeToken,
  signWithdrawRequest,
  tronDeposit,
  tronDepositNative,
  tronWithdraw,
  withdrawRequestMessage,
  type EvmWithdrawalVoucher,
  type TronSender,
} from "@aspensprotocol/sdk-ts";

export interface TronTransferDeps {
  assertTronWithdrawTrx: typeof assertTronWithdrawTrx;
  signWithdrawRequest: typeof signWithdrawRequest;
  tronDeposit: typeof tronDeposit;
  tronDepositNative: typeof tronDepositNative;
  tronWithdraw: typeof tronWithdraw;
}

const SDK: TronTransferDeps = {
  assertTronWithdrawTrx,
  signWithdrawRequest,
  tronDeposit,
  tronDepositNative,
  tronWithdraw,
};

/** The chain and token a transfer is on, as the venue's config names them. */
export interface TronTransferTarget {
  network: string;
  /** `Chain.architecture` as configured ("Tron"). */
  architecture: string;
  /** The MidribV3 instance, `0x` hex. */
  contract: string;
  /** The token, `0x` hex (the native sentinel for TRX). */
  token: string;
  /** Base units. */
  amount: bigint;
}

/** Deposit: TRX as `depositNative`'s call value, a token by `deposit`. */
export async function depositOnTron(
  sender: TronSender,
  target: TronTransferTarget,
  deps: TronTransferDeps = SDK,
): Promise<void> {
  if (isNativeToken(target.token)) {
    await deps.tronDepositNative({
      ...sender,
      contract: target.contract,
      amount: target.amount,
    });
  } else {
    await deps.tronDeposit({
      ...sender,
      contract: target.contract,
      token: target.token,
      amount: target.amount,
    });
  }
}

/** What a withdraw needs from the venue and the page. */
export interface TronWithdrawHooks {
  requestVoucher: (request: {
    network: string;
    token: string;
    account: string;
    amount: string;
    signature: Uint8Array;
  }) => Promise<EvmWithdrawalVoucher>;
  /** Progress for the user, before each step that waits on them or the venue. */
  notify?: (step: "sign" | "voucher" | "submit") => void;
}

/**
 * Withdraw through the venue's voucher: check TRX, sign the request, fetch
 * the voucher, check its amount, submit it.
 */
export async function withdrawOnTron(
  sender: TronSender,
  target: TronTransferTarget,
  hooks: TronWithdrawHooks,
  deps: TronTransferDeps = SDK,
): Promise<void> {
  await deps.assertTronWithdrawTrx({ node: sender.node, owner: sender.owner });

  const canonical = withdrawRequestMessage({
    network: target.network,
    token: target.token,
    account: sender.owner,
    amount: target.amount,
  });
  hooks.notify?.("sign");
  const signature = await deps.signWithdrawRequest(
    canonical,
    sender.adapter,
    target.architecture,
  );

  hooks.notify?.("voucher");
  const voucher = await hooks.requestVoucher({
    network: target.network,
    token: target.token,
    account: sender.owner,
    amount: target.amount.toString(),
    signature,
  });
  if (BigInt(voucher.amount) !== target.amount) {
    throw new Error(
      `The arborter issued a voucher for ${voucher.amount.toString()} base ` +
        `units, not the ${target.amount.toString()} requested. Nothing was ` +
        `submitted; the hold expires on its own.`,
    );
  }

  hooks.notify?.("submit");
  await deps.tronWithdraw({ ...sender, contract: target.contract, voucher });
}
