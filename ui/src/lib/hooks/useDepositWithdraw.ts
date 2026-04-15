/**
 * Deposit / withdraw hooks covering both chain ecosystems.
 *
 *   - EVM: ERC-20.approve (if allowance insufficient) + MidribV2.deposit /
 *     MidribV2.withdraw via wagmi writeContract. Waits for receipts.
 *   - Solana: Midrib program deposit_ix / withdraw_ix via
 *     @solana/web3.js Transaction + wallet-adapter sendTransaction.
 *
 * Dispatches on the chain's `architecture` field; errors surface via
 * sonner.
 */

import { useCallback, useState } from "react";
import {
  readContract,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { parseAbi, type Address } from "viem";
import {
  Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  depositIx as buildDepositIx,
  withdrawIx as buildWithdrawIx,
} from "@exchange/sdk";
import { toast } from "sonner";

import { getWagmiConfig } from "@/lib/web3modal-config";
import { getSolanaWalletContext } from "@/lib/wallet/solana-adapter";
import { useExchangeClient } from "./useExchangeClient";

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const MIDRIB_ABI = parseAbi([
  "function deposit(address _token, uint160 _amount)",
  "function withdraw(address _tokenContract, uint160 _amount)",
]);

export interface DepositParams {
  chainNetwork: string;
  tokenTicker: string;
  /** Amount in raw base units (already scaled by the token's decimals). */
  amount: bigint;
}

export interface UseDepositWithdrawResult {
  deposit: (params: DepositParams) => Promise<void>;
  withdraw: (params: DepositParams) => Promise<void>;
  pending: boolean;
}

interface BuildIxOpts {
  programId: PublicKey;
  instance: PublicKey;
  user: PublicKey;
  mint: PublicKey;
  amount: bigint;
}

/**
 * Shared Solana submit path: build the ix from `buildIx`, pack into a
 * single-instruction Transaction, send via the wallet adapter's
 * sendTransaction, and wait for confirmation. Keeps the deposit /
 * withdraw call sites identical apart from the ix builder.
 */
async function submitSolanaIx(opts: {
  chainRpcUrl: string;
  programIdStr: string;
  instanceStr: string;
  mintStr: string;
  amount: bigint;
  buildIx: (opts: BuildIxOpts) => TransactionInstruction;
  pendingLabel: string;
  successLabel: string;
}): Promise<void> {
  const wallet = getSolanaWalletContext();
  if (!wallet?.publicKey || !wallet.sendTransaction) {
    throw new Error("Connect a Solana wallet to continue");
  }
  if (!opts.programIdStr) {
    throw new Error(
      "Solana chain is missing a trade-program id (factory_address)",
    );
  }
  if (!opts.instanceStr) {
    throw new Error(
      "Solana chain is missing a trading-instance address (trade_contract.address)",
    );
  }

  const connection = new Connection(opts.chainRpcUrl, "confirmed");
  const programId = new PublicKey(opts.programIdStr);
  const instance = new PublicKey(opts.instanceStr);
  const mint = new PublicKey(opts.mintStr);
  const user = wallet.publicKey;

  const ix = opts.buildIx({
    programId,
    instance,
    user,
    mint,
    amount: opts.amount,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = user;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  toast.info(opts.pendingLabel);
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(sig, "confirmed");
  toast.success(opts.successLabel);
}

export function useDepositWithdraw(): UseDepositWithdrawResult {
  const client = useExchangeClient();
  const [pending, setPending] = useState(false);

  const resolveChainAndToken = useCallback(
    (chainNetwork: string, tokenTicker: string) => {
      const config = client.cache.getConfig();
      if (!config) throw new Error("Arborter configuration not loaded");
      const chain = config.chains.find((c) => c.network === chainNetwork);
      if (!chain) throw new Error(`Chain '${chainNetwork}' not found`);
      const token = chain.tokens[tokenTicker];
      if (!token) {
        throw new Error(
          `Token '${tokenTicker}' not configured on '${chainNetwork}'`,
        );
      }
      const midrib = chain.tradeContract?.address;
      if (!midrib) {
        throw new Error(
          `Trade contract not deployed on '${chainNetwork}' — cannot deposit`,
        );
      }
      return { chain, token, midrib };
    },
    [client],
  );

  const deposit = useCallback(
    async (params: DepositParams) => {
      const { chain, token, midrib } = resolveChainAndToken(
        params.chainNetwork,
        params.tokenTicker,
      );

      setPending(true);
      try {
        if (chain.architecture.match(/^solana$/i)) {
          await submitSolanaIx({
            chainRpcUrl: chain.rpcUrl,
            // For Solana: `factory_address` is the program id, and
            // `trade_contract.address` is the instance PDA. Both are
            // required to build deposit_ix.
            programIdStr:
              chain.factoryAddress || chain.tradeContract?.contractId || "",
            instanceStr: midrib,
            mintStr: token.address,
            amount: params.amount,
            buildIx: ({ programId, instance, user, mint, amount }) =>
              buildDepositIx({ programId, instance, user, mint, amount }),
            pendingLabel: "Depositing…",
            successLabel: `Deposit confirmed on ${chain.network}`,
          });
          return;
        }
        const wagmi = getWagmiConfig();
        const tokenAddr = token.address as Address;
        const midribAddr = midrib as Address;
        const account = (await import("wagmi/actions")).getAccount(wagmi)
          .address as Address | undefined;
        if (!account) throw new Error("Connect an EVM wallet to deposit");

        // 1. Top up the ERC-20 allowance to MidribV2 if short. Reusing an
        // existing allowance when it's sufficient spares the user a
        // needless approval prompt.
        const allowance = (await readContract(wagmi, {
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [account, midribAddr],
        })) as bigint;

        if (allowance < params.amount) {
          toast.info("Approving token transfer…", {
            description: `${params.tokenTicker} → MidribV2`,
          });
          const approveHash = await writeContract(wagmi, {
            address: tokenAddr,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [midribAddr, params.amount],
          });
          await waitForTransactionReceipt(wagmi, { hash: approveHash });
        }

        // 2. Move funds into the trade contract.
        toast.info("Depositing…");
        const depositHash = await writeContract(wagmi, {
          address: midribAddr,
          abi: MIDRIB_ABI,
          functionName: "deposit",
          args: [tokenAddr, params.amount],
        });
        await waitForTransactionReceipt(wagmi, { hash: depositHash });
        toast.success("Deposit confirmed", {
          description: `${params.tokenTicker} on ${chain.network}`,
        });
      } catch (err) {
        console.error("[useDepositWithdraw] deposit failed:", err);
        toast.error("Deposit failed", {
          description: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        setPending(false);
      }
    },
    [resolveChainAndToken],
  );

  const withdraw = useCallback(
    async (params: DepositParams) => {
      const { chain, token, midrib } = resolveChainAndToken(
        params.chainNetwork,
        params.tokenTicker,
      );

      setPending(true);
      try {
        if (chain.architecture.match(/^solana$/i)) {
          await submitSolanaIx({
            chainRpcUrl: chain.rpcUrl,
            programIdStr:
              chain.factoryAddress || chain.tradeContract?.contractId || "",
            instanceStr: midrib,
            mintStr: token.address,
            amount: params.amount,
            buildIx: ({ programId, instance, user, mint, amount }) =>
              buildWithdrawIx({ programId, instance, user, mint, amount }),
            pendingLabel: "Withdrawing…",
            successLabel: `Withdraw confirmed on ${chain.network}`,
          });
          return;
        }
        const wagmi = getWagmiConfig();
        toast.info("Withdrawing…");
        const hash = await writeContract(wagmi, {
          address: midrib as Address,
          abi: MIDRIB_ABI,
          functionName: "withdraw",
          args: [token.address as Address, params.amount],
        });
        await waitForTransactionReceipt(wagmi, { hash });
        toast.success("Withdraw confirmed", {
          description: `${params.tokenTicker} on ${chain.network}`,
        });
      } catch (err) {
        console.error("[useDepositWithdraw] withdraw failed:", err);
        toast.error("Withdraw failed", {
          description: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        setPending(false);
      }
    },
    [resolveChainAndToken],
  );

  return { deposit, withdraw, pending };
}
