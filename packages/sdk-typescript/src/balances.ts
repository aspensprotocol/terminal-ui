/**
 * On-chain balance queries.
 *
 * Replaces the old `getBalances()` stub with real lookups across every
 * chain in the arborter `Configuration` that the user has a connected
 * wallet on. For each (chain, token, wallet) tuple we fetch:
 *
 *   - deposited — balance held inside the trade contract (EVM:
 *     `MidribV3.tradeBalance`; Solana: the `deposited` field on the
 *     `UserBalance` PDA).
 *   - locked — portion of `deposited` tied up in open orders. NOTE: under
 *     the optimistic shadow ledger, order collateral is reserved OFF-chain,
 *     so MidribV3 has no `lockedTradeBalance` getter; that read fails and
 *     degrades to `0n`, meaning EVM `locked` currently always reports zero.
 *     Solana still reads the `locked` field on the `UserBalance` PDA.
 *   - wallet — the user's raw chain-level balance (ERC-20 `balanceOf`
 *     or SPL token account). Used by the deposit UI, not the balances
 *     panel.
 *
 * Results are aggregated per token ticker (summed across chains the
 * token appears on) to match the shape `EnhancedBalance[]` the UI
 * already consumes.
 */

import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { Connection, PublicKey } from "@solana/web3.js";

import type { Configuration } from "./protos/arborter_config_pb.js";
import type { EnhancedBalance } from "./types.js";
import { resolveRpcUrl, type RpcUrlMap } from "./rpc-urls.js";
import { isNativeToken, isWsolMint } from "./native.js";

/** SPL Token program id — well-known constant. */
const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
/** SPL Associated Token Account program id. */
const ATA_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);
const MIDRIB_BALANCE_ABI = parseAbi([
  "function tradeBalance(address holder, address token) view returns (uint256)",
  "function lockedTradeBalance(address holder, address token) view returns (uint256)",
]);

/** A user wallet binding produced by the UI's multi-wallet manager. */
export interface WalletBinding {
  /** Address in its native form (0x-hex for EVM, base58 for Solana). */
  address: string;
  /** Matches `Chain.architecture` (case-insensitive). */
  ecosystem: "evm" | "solana";
}

/** Per-chain slice before aggregation; useful for debugging / deposit UI. */
export interface ChainBalanceSlice {
  chainNetwork: string;
  tokenTicker: string;
  tokenAddress: string;
  tokenDecimals: number;
  deposited: bigint;
  locked: bigint;
  /** User's wallet balance on-chain (outside the trade contract). */
  wallet: bigint;
}

// -- Entry points --------------------------------------------------------

/**
 * Fetch every chain slice for the given wallets, then aggregate into
 * per-ticker `EnhancedBalance` rows. Chains whose architecture doesn't
 * match any connected wallet are skipped.
 */
export async function fetchOnChainBalances(opts: {
  wallets: WalletBinding[];
  config: Configuration;
  rpcUrls?: RpcUrlMap;
}): Promise<EnhancedBalance[]> {
  const slices = await fetchChainBalanceSlices(opts);
  return aggregateSlicesToEnhancedBalances(slices, opts.wallets);
}

/**
 * Same as `fetchOnChainBalances` but without the per-ticker aggregation.
 *
 * `rpcUrls` maps `chain.network` to an endpoint the browser can dial. It is
 * required in practice: the arborter masks `rpc_url` in `GetConfig`, so a
 * chain with no override has no reachable endpoint. Such chains are SKIPPED
 * with a console warning rather than contributing silent zeros — see
 * `rpc-urls.ts`.
 */
export async function fetchChainBalanceSlices(opts: {
  wallets: WalletBinding[];
  config: Configuration;
  rpcUrls?: RpcUrlMap;
}): Promise<ChainBalanceSlice[]> {
  const walletByEcosystem = new Map<string, WalletBinding>();
  for (const w of opts.wallets) walletByEcosystem.set(w.ecosystem, w);

  const tasks: Promise<ChainBalanceSlice[]>[] = [];
  const unreachable: string[] = [];
  for (const chain of opts.config.chains) {
    const arch = chain.architecture.toLowerCase();
    if (arch !== "evm" && arch !== "solana") continue;
    const wallet = walletByEcosystem.get(arch);
    if (!wallet) continue;

    const rpcUrl = resolveRpcUrl(chain, opts.rpcUrls);
    if (!rpcUrl) {
      unreachable.push(chain.network);
      continue;
    }

    if (arch === "evm") {
      tasks.push(fetchEvmChainSlices(chain, wallet.address, rpcUrl));
    } else {
      tasks.push(fetchSolanaChainSlices(chain, wallet.address, rpcUrl));
    }
  }
  if (unreachable.length > 0) {
    console.warn(
      `[balances] no usable RPC endpoint for ${unreachable.join(", ")} — ` +
        `balances for these chains are OMITTED, not zero. The arborter masks ` +
        `rpc_url in GetConfig; supply an endpoint per chain (CHAIN_RPC_URLS).`,
    );
  }
  const results = await Promise.all(tasks);
  return results.flat();
}

/** Fetch wallet-only balance for a single (chain, token, user) tuple. */
export async function fetchWalletBalance(opts: {
  chain: ChainConfig;
  tokenAddress: string;
  user: string;
  /** Overrides the (masked) `chain.rpcUrl`; see `rpc-urls.ts`. */
  rpcUrls?: RpcUrlMap;
}): Promise<bigint> {
  const arch = opts.chain.architecture.toLowerCase();
  const rpcUrl = resolveRpcUrl(opts.chain, opts.rpcUrls);
  if (!rpcUrl) {
    throw new Error(
      `no usable RPC endpoint for chain '${opts.chain.network}' ` +
        `(GetConfig masks rpc_url — supply one via CHAIN_RPC_URLS)`,
    );
  }
  if (arch === "evm") {
    const client = createPublicClient({ transport: http(rpcUrl) });
    return readEvmWalletBalance(
      client,
      opts.tokenAddress,
      getAddress(opts.user),
    );
  }
  if (arch === "solana") {
    const conn = new Connection(rpcUrl);
    const mint = new PublicKey(opts.tokenAddress);
    const owner = new PublicKey(opts.user);
    const ata = deriveAssociatedTokenAccount(owner, mint);
    return solanaNativeWallet(conn, opts.tokenAddress, owner, ata);
  }
  throw new Error(
    `unsupported chain architecture '${opts.chain.architecture}'`,
  );
}

/**
 * A user's on-chain holding of `tokenAddress`, native asset included.
 *
 * The native asset is keyed in MidribV3 by a SENTINEL address
 * (`0xEeee…EEeE`) that has no code deployed at it. Calling ERC-20 `balanceOf`
 * on it always reverts, and the revert used to be swallowed into `0n` — so a
 * wallet holding 94 C2FLR showed as empty and the deposit dialog capped the
 * amount at zero. Native balances come from `getBalance`; only real tokens go
 * through `balanceOf`.
 *
 * Failures still degrade to `0n`: one flaky token must not blank the panel.
 */
export async function readEvmWalletBalance(
  client: Pick<PublicClient, "getBalance" | "readContract">,
  tokenAddress: string,
  user: Address,
): Promise<bigint> {
  if (isNativeToken(tokenAddress)) {
    return client.getBalance({ address: user }).catch(() => 0n);
  }
  return client
    .readContract({
      address: getAddress(tokenAddress),
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [user],
    })
    .then((v) => v as bigint)
    .catch(() => 0n);
}

// -- EVM path ------------------------------------------------------------

type ChainConfig = Configuration["chains"][number];

async function fetchEvmChainSlices(
  chain: ChainConfig,
  userAddress: string,
  rpcUrl: string,
): Promise<ChainBalanceSlice[]> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const user = getAddress(userAddress);
  const midrib = chain.tradeContract?.address
    ? getAddress(chain.tradeContract.address)
    : undefined;

  const results: ChainBalanceSlice[] = [];
  for (const [ticker, token] of Object.entries(chain.tokens)) {
    const tokenAddr = getAddress(token.address);

    // Wallet + trade-contract queries in parallel; any individual failure
    // (e.g. an RPC hiccup or a token that doesn't implement balanceOf)
    // degrades to zero for that slice rather than failing the whole panel.
    const [walletRaw, depositedRaw, lockedRaw] = await Promise.all([
      readEvmWalletBalance(client, token.address, user),
      midrib
        ? client
            .readContract({
              address: midrib,
              abi: MIDRIB_BALANCE_ABI,
              functionName: "tradeBalance",
              args: [user, tokenAddr],
            })
            .catch(() => 0n)
        : Promise.resolve(0n),
      midrib
        ? client
            .readContract({
              address: midrib,
              abi: MIDRIB_BALANCE_ABI,
              functionName: "lockedTradeBalance",
              args: [user, tokenAddr],
            })
            .catch(() => 0n)
        : Promise.resolve(0n),
    ]);

    results.push({
      chainNetwork: chain.network,
      tokenTicker: ticker,
      tokenAddress: tokenAddr,
      tokenDecimals: token.decimals,
      deposited: depositedRaw,
      locked: lockedRaw,
      wallet: walletRaw,
    });
  }
  return results;
}

/**
 * A user's holding of `mintAddress` on Solana.
 *
 * Native SOL trades as WSOL, and the SDK wraps client-side at deposit time —
 * so for the WSOL mint the depositable holding is the account's LAMPORTS plus
 * whatever is already wrapped in its token account. Reading only the token
 * account (the previous behaviour) reported 0 for a user with plenty of SOL
 * and no WSOL account yet, the Solana twin of the EVM sentinel bug.
 *
 * Caveat: the deposit flow wraps the full requested amount from lamports, so a
 * deposit that leans on the already-wrapped portion will fail until that flow
 * learns to spend existing WSOL. Reporting the true holding is still right —
 * understating it hides funds.
 */
export async function solanaNativeWallet(
  conn: Pick<Connection, "getBalance" | "getTokenAccountBalance">,
  mintAddress: string,
  owner: PublicKey,
  ata: PublicKey,
): Promise<bigint> {
  const wrapped = await conn
    .getTokenAccountBalance(ata)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n); // account not yet created => nothing wrapped
  if (!isWsolMint(mintAddress)) return wrapped;
  const lamports = await conn
    .getBalance(owner)
    .then((v) => BigInt(v))
    .catch(() => 0n);
  return wrapped + lamports;
}

// -- Solana path ---------------------------------------------------------

async function fetchSolanaChainSlices(
  chain: ChainConfig,
  userAddress: string,
  rpcUrl: string,
): Promise<ChainBalanceSlice[]> {
  const conn = new Connection(rpcUrl);
  const owner = new PublicKey(userAddress);

  // Program id + instance PDA for the Midrib trade program on this chain.
  const programIdStr =
    chain.factoryAddress || chain.tradeContract?.contractId || "";
  const instanceStr = chain.tradeContract?.address ?? "";
  const programId = programIdStr ? new PublicKey(programIdStr) : null;
  const instance = instanceStr ? new PublicKey(instanceStr) : null;

  const results: ChainBalanceSlice[] = [];
  for (const [ticker, token] of Object.entries(chain.tokens)) {
    const mint = new PublicKey(token.address);
    const ata = deriveAssociatedTokenAccount(owner, mint);

    // Wallet balance via the ATA, plus lamports for the native (WSOL) leg.
    // Deposited / locked via the UserBalance PDA if the program + instance
    // are configured; otherwise zero.
    const walletPromise: Promise<bigint> = solanaNativeWallet(
      conn,
      token.address,
      owner,
      ata,
    );

    let depositedPromise = Promise.resolve(0n);
    let lockedPromise = Promise.resolve(0n);
    if (programId && instance) {
      const [userBalancePda] = PublicKey.findProgramAddressSync(
        [
          new TextEncoder().encode("balance"),
          instance.toBuffer(),
          owner.toBuffer(),
          mint.toBuffer(),
        ],
        programId,
      );
      const pdaPromise: Promise<
        import("@solana/web3.js").AccountInfo<Uint8Array> | null
      > = conn.getAccountInfo(userBalancePda).catch(() => null);
      depositedPromise = pdaPromise.then((info) =>
        info ? readU64Le(info.data, 8 + 32 * 3) : 0n,
      );
      lockedPromise = pdaPromise.then((info) =>
        info ? readU64Le(info.data, 8 + 32 * 3 + 8) : 0n,
      );
    }

    const [wallet, deposited, locked] = await Promise.all([
      walletPromise,
      depositedPromise,
      lockedPromise,
    ]);

    results.push({
      chainNetwork: chain.network,
      tokenTicker: ticker,
      tokenAddress: token.address,
      tokenDecimals: token.decimals,
      deposited,
      locked,
      wallet,
    });
  }
  return results;
}

// -- Aggregation ---------------------------------------------------------

function aggregateSlicesToEnhancedBalances(
  slices: ChainBalanceSlice[],
  wallets: WalletBinding[],
): EnhancedBalance[] {
  // Pick a representative user_address for the EnhancedBalance row. The UI
  // joins on token ticker so the exact value doesn't matter much — prefer
  // the EVM wallet if present, else the Solana one, else the empty string.
  const representativeAddress =
    wallets.find((w) => w.ecosystem === "evm")?.address ??
    wallets.find((w) => w.ecosystem === "solana")?.address ??
    "";

  const byTicker = new Map<
    string,
    {
      deposited: bigint;
      locked: bigint;
      decimals: number;
    }
  >();
  for (const s of slices) {
    const prior = byTicker.get(s.tokenTicker);
    if (prior) {
      prior.deposited += s.deposited;
      prior.locked += s.locked;
    } else {
      byTicker.set(s.tokenTicker, {
        deposited: s.deposited,
        locked: s.locked,
        decimals: s.tokenDecimals,
      });
    }
  }

  const out: EnhancedBalance[] = [];
  for (const [ticker, agg] of byTicker) {
    const scale = 10n ** BigInt(agg.decimals);
    const amountValue = bigIntToFloat(agg.deposited, scale);
    const lockedValue = bigIntToFloat(agg.locked, scale);
    const available = amountValue - lockedValue;

    const amountStr = agg.deposited.toString();
    const lockedStr = agg.locked.toString();
    const availableStr = (agg.deposited - agg.locked).toString();

    out.push({
      user_address: representativeAddress,
      token_ticker: ticker,
      amount: amountStr,
      open_interest: "0",
      locked: lockedStr,
      updated_at: new Date().toISOString(),
      amountValue,
      lockedValue,
      displayAmount: amountValue.toString(),
      displayOpenInterest: "0",
      amountDisplay: amountValue.toString(),
      available: availableStr,
      displayAvailable: available.toString(),
    });
  }
  return out;
}

// -- Shared helpers ------------------------------------------------------

/** SPL ATA derivation — equivalent to `getAssociatedTokenAddressSync` in spl-token. */
function deriveAssociatedTokenAccount(
  owner: PublicKey,
  mint: PublicKey,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

/** Decode a u64 LE at `offset` into a bigint; returns 0n if out of range. */
function readU64Le(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 8) return 0n;
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(data[offset + i]);
  }
  return value;
}

/** Convert a raw bigint + scale (10^decimals) into a lossy JS number. */
function bigIntToFloat(raw: bigint, scale: bigint): number {
  if (scale === 0n) return 0;
  const whole = raw / scale;
  const frac = raw % scale;
  return Number(whole) + Number(frac) / Number(scale);
}
