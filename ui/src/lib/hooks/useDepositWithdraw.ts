/**
 * Deposit / withdraw hooks covering both chain ecosystems.
 *
 *   - EVM deposit: ERC-20.approve (if allowance insufficient) +
 *     MidribV3.deposit via wagmi writeContract; native tokens (the
 *     NATIVE_TOKEN_SENTINEL address) skip approve and send value through
 *     the payable MidribV3.depositNative.
 *   - EVM withdraw: TEE voucher flow (Track A §8) — sign the canonical
 *     request, fetch a voucher over gRPC, submit
 *     MidribV3.withdraw(voucher, signature). Works identically for
 *     ERC-20 and native (the contract pays raw value for the sentinel).
 *   - Solana: Midrib program deposit_ix / withdraw_ix via
 *     @solana/web3.js Transaction + wallet-adapter sendTransaction.
 *     Native SOL (the WSOL mint) wraps in the same tx before a deposit
 *     (create ATA → transfer lamports → SyncNative) and unwraps after a
 *     withdraw (CloseAccount).
 *
 * Dispatches on the chain's `architecture` field; errors surface via
 * sonner.
 */

import { useCallback, useState } from "react";
import {
  getAccount,
  signMessage,
  switchChain,
  writeContract,
} from "wagmi/actions";
import { parseAbi, type Address, type Hex } from "viem";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  depositIx as buildDepositIx,
  withdrawIx as buildWithdrawIx,
  createIdempotentAtaIx,
  syncNativeIx,
  closeAccountIx,
  deriveAssociatedTokenAccount,
  isNativeToken,
  isWsolMint,
  bytesToHex,
  resolveRpcUrl,
  publicClientFor,
  ensureWalletChain,
  type RpcUrlMap,
  type RpcResolvableChain,
} from "@aspens/terminal-sdk";
import { toast } from "sonner";

import { getWagmiConfig } from "@/lib/web3modal-config";
import { getSolanaWalletContext } from "@/lib/wallet/solana-adapter";
import { useExchangeClient } from "./useExchangeClient";
import { useRpcUrls } from "../providers/rpc-context";

/**
 * Endpoint for a Solana chain's own RPC calls. The EVM paths go through
 * wagmi (the wallet supplies the transport), but Solana builds its own
 * `Connection`, so it hits the same masked-`rpc_url` problem the balances
 * panel does — see `rpc-urls.ts` in the SDK.
 */
/**
 * Wallet hooks for `ensureWalletChain`, bound to the wagmi config.
 *
 * `switchChain` prompts `wallet_switchEthereumChain`, and wagmi's injected
 * connector falls back to `wallet_addEthereumChain` when the wallet does not
 * know the chain yet — so both Coston2 and HyperEVM must stay registered in
 * web3modal-config.ts with real RPC URLs for this to work.
 */
function walletChainDeps(
  wagmi: ReturnType<typeof getWagmiConfig>,
  label: string,
) {
  return {
    currentChainId: () => getAccount(wagmi).chainId,
    requestSwitch: async (chainId: number) => {
      await switchChain(wagmi, { chainId });
    },
    onSwitching: () =>
      toast.info("Switching network…", {
        description: `Approve the change in your wallet to ${label}`,
      }),
  };
}

function resolveSolanaRpcUrl(
  chain: RpcResolvableChain,
  rpcUrls: RpcUrlMap,
): string {
  const url = resolveRpcUrl(chain, rpcUrls);
  if (!url) {
    throw new Error(
      `No RPC endpoint configured for '${chain.network}'. The arborter masks ` +
        `rpc_url in GetConfig — set CHAIN_RPC_URLS for this deployment.`,
    );
  }
  return url;
}

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const MIDRIB_ABI = parseAbi([
  "struct WithdrawalVoucher { address account; address token; uint256 amount; uint256 nonce; uint256 expiry; }",
  "function deposit(address _token, uint160 _amount)",
  "function depositNative() payable",
  "function withdraw(WithdrawalVoucher _v, bytes _signature)",
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
 * Shared Solana submit path: build the instruction list from `buildIxs`,
 * pack into a single Transaction, send via the wallet adapter's
 * sendTransaction, and wait for confirmation. Keeps the deposit /
 * withdraw call sites identical apart from the ix builders (a WSOL
 * deposit is a 4-ix wrap+deposit; everything else is a single ix).
 */
async function submitSolanaIxs(opts: {
  chainRpcUrl: string;
  programIdStr: string;
  instanceStr: string;
  mintStr: string;
  amount: bigint;
  buildIxs: (opts: BuildIxOpts) => TransactionInstruction[];
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

  const ixs = opts.buildIxs({
    programId,
    instance,
    user,
    mint,
    amount: opts.amount,
  });
  const tx = new Transaction().add(...ixs);
  tx.feePayer = user;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  toast.info(opts.pendingLabel);
  const sig = await wallet.sendTransaction(tx, connection);
  await connection.confirmTransaction(sig, "confirmed");
  toast.success(opts.successLabel);
}

export function useDepositWithdraw(): UseDepositWithdrawResult {
  const client = useExchangeClient();
  const rpcUrls = useRpcUrls();
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
          const wrapSol = isWsolMint(token.address);
          await submitSolanaIxs({
            chainRpcUrl: resolveSolanaRpcUrl(chain, rpcUrls),
            // For Solana: `factory_address` is the program id, and
            // `trade_contract.address` is the instance PDA. Both are
            // required to build deposit_ix.
            programIdStr:
              chain.factoryAddress || chain.tradeContract?.contractId || "",
            instanceStr: midrib,
            mintStr: token.address,
            amount: params.amount,
            buildIxs: ({ programId, instance, user, mint, amount }) => {
              const depositInstruction = buildDepositIx({
                programId,
                instance,
                user,
                mint,
                amount,
              });
              if (!wrapSol) return [depositInstruction];
              // Native SOL: wrap in the same tx — create the WSOL ATA
              // (idempotent), move `amount` lamports into it, SyncNative
              // so the token balance reflects them, then deposit.
              const ata = deriveAssociatedTokenAccount(user, mint);
              return [
                createIdempotentAtaIx(user, user, mint, ata),
                SystemProgram.transfer({
                  fromPubkey: user,
                  toPubkey: ata,
                  lamports: params.amount,
                }),
                syncNativeIx(ata),
                depositInstruction,
              ];
            },
            pendingLabel: wrapSol ? "Wrapping + depositing…" : "Depositing…",
            successLabel: `Deposit confirmed on ${chain.network}`,
          });
          return;
        }
        const wagmi = getWagmiConfig();
        const tokenAddr = token.address as Address;
        const midribAddr = midrib as Address;
        const acct = getAccount(wagmi);
        const account = acct.address as Address | undefined;
        if (!account) throw new Error("Connect an EVM wallet to deposit");
        // Writes go through the wallet on whatever chain it is currently on,
        // so a wallet left on another network would broadcast there. Refuse
        // instead.
        await ensureWalletChain(chain, walletChainDeps(wagmi, chain.network));
        // Reads use the chain's OWN endpoint, never wagmi's transports —
        // see evm-client.ts for why.
        const pub = publicClientFor(chain, rpcUrls);

        // Native asset (sentinel token): no ERC-20 approve — the value
        // rides the payable depositNative call.
        if (isNativeToken(token.address)) {
          toast.info("Depositing…");
          const depositHash = await writeContract(wagmi, {
            address: midribAddr,
            abi: MIDRIB_ABI,
            functionName: "depositNative",
            value: params.amount,
          });
          await pub.waitForTransactionReceipt({ hash: depositHash });
          toast.success("Deposit confirmed", {
            description: `${params.tokenTicker} on ${chain.network}`,
          });
          return;
        }

        // 1. Top up the ERC-20 allowance to MidribV3 if short. Reusing an
        // existing allowance when it's sufficient spares the user a
        // needless approval prompt.
        const allowance = (await pub.readContract({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [account, midribAddr],
        })) as bigint;

        if (allowance < params.amount) {
          toast.info("Approving token transfer…", {
            description: `${params.tokenTicker} → MidribV3`,
          });
          const approveHash = await writeContract(wagmi, {
            address: tokenAddr,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [midribAddr, params.amount],
          });
          await pub.waitForTransactionReceipt({ hash: approveHash });
        }

        // 2. Move funds into the trade contract.
        toast.info("Depositing…");
        const depositHash = await writeContract(wagmi, {
          address: midribAddr,
          abi: MIDRIB_ABI,
          functionName: "deposit",
          args: [tokenAddr, params.amount],
        });
        await pub.waitForTransactionReceipt({ hash: depositHash });
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
    [resolveChainAndToken, rpcUrls],
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
          const unwrapSol = isWsolMint(token.address);
          await submitSolanaIxs({
            chainRpcUrl: resolveSolanaRpcUrl(chain, rpcUrls),
            programIdStr:
              chain.factoryAddress || chain.tradeContract?.contractId || "",
            instanceStr: midrib,
            mintStr: token.address,
            amount: params.amount,
            buildIxs: ({ programId, instance, user, mint, amount }) => {
              const ixs = [
                buildWithdrawIx({ programId, instance, user, mint, amount }),
              ];
              if (unwrapSol) {
                // Native SOL: unwrap by closing the WSOL ATA after the
                // withdraw credits it — sends the account's ENTIRE
                // wrapped balance + rent back to the user as SOL.
                const ata = deriveAssociatedTokenAccount(user, mint);
                ixs.push(closeAccountIx(ata, user, user));
              }
              return ixs;
            },
            pendingLabel: unwrapSol
              ? "Withdrawing + unwrapping…"
              : "Withdrawing…",
            successLabel: `Withdraw confirmed on ${chain.network}`,
          });
          return;
        }

        // EVM: the TEE voucher flow (Track A §8). MidribV3 has no
        // permissionless withdraw — the arborter (which knows the
        // withdrawable balance net of off-chain reservations) signs a
        // voucher this wallet then submits on-chain.
        const wagmi = getWagmiConfig();
        const acct = getAccount(wagmi);
        const account = acct.address as Address | undefined;
        if (!account) throw new Error("Connect an EVM wallet to withdraw");
        // Same guard as deposit: the voucher is bound to this chain, so a
        // wallet on another network must not submit it there.
        await ensureWalletChain(chain, walletChainDeps(wagmi, chain.network));
        const pub = publicClientFor(chain, rpcUrls);

        // 1. Authenticate the voucher request: EIP-191 personal-sign over
        // the canonical bytes the arborter rebuilds.
        const canonical = `${chain.network}|${token.address}|${account}|${params.amount.toString()}`;
        toast.info("Sign the withdrawal request in your wallet…");
        const requestSig = await signMessage(wagmi, { message: canonical });
        const requestSigBytes = new Uint8Array(
          (requestSig.slice(2).match(/.{2}/g) ?? []).map((b) =>
            parseInt(b, 16),
          ),
        );

        // 2. Fetch the TEE-signed voucher (this places an off-chain hold).
        toast.info("Requesting withdrawal voucher…");
        const voucher = await client.requestWithdrawVoucher({
          network: chain.network,
          token: token.address,
          account,
          amount: params.amount.toString(),
          signature: requestSigBytes,
        });

        // 3. Submit the voucher on-chain. Native tokens (sentinel) are paid
        // out as raw value by the same call.
        toast.info("Withdrawing…");
        const hash = await writeContract(wagmi, {
          address: midrib as Address,
          abi: MIDRIB_ABI,
          functionName: "withdraw",
          args: [
            {
              account: voucher.account as Address,
              token: voucher.token as Address,
              amount: BigInt(voucher.amount),
              nonce: voucher.nonce,
              expiry: voucher.expiry,
            },
            bytesToHex(voucher.signature) as Hex,
          ],
        });
        await pub.waitForTransactionReceipt({ hash });
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
    [client, resolveChainAndToken, rpcUrls],
  );

  return { deposit, withdraw, pending };
}
