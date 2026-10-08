/**
 * RPC endpoint resolution for browser-side chain reads.
 *
 * The arborter masks every RPC endpoint's `url` in its `GetConfig` response
 * (RPC URLs commonly embed an API key — in the query string, userinfo, OR a
 * path segment for hosted providers like Alchemy/Infura — and `GetConfig` is
 * unauthenticated), so a browser client cannot dial the URL it receives in
 * `Configuration`. Callers supply their own map of `chain.network` -> endpoint
 * instead; `resolveRpcUrl` prefers that map, falls back to the config value
 * only when it is genuinely usable, and last to a static list of free public
 * endpoints for the chains Aspens venues run on ({@link PUBLIC_RPC_URLS}).
 *
 * When none of the three yields a usable endpoint this returns `null` so the caller can
 * SKIP the chain and say so. That is the point of the module: a mask passed
 * straight to viem makes every read throw, and a throw swallowed into `0n`
 * produces a balances panel of zeros that looks exactly like "you have no
 * deposits".
 *
 * Long term the arborter should publish a non-secret `public_rpc_url` per chain
 * so this map is unnecessary; see the RPC-MASK-1 tech-debt item.
 */

/** The fixed mask the arborter substitutes for a whole `url` it cannot parse. */
export const MASKED_RPC_URL = "********";

/** Minimal shape of one `chain.rpcs[n]` entry needed to pick an endpoint. */
export interface RpcEndpointLike {
  url: string;
  enabled: boolean;
}

/**
 * Minimal shape needed to resolve an endpoint — matches `Configuration.chains[n]`:
 * every chain carries a priority-ordered, per-endpoint-auth `rpcs` list.
 *
 * `chainId` and `architecture` are optional because only the public-endpoint
 * fallback reads them: EVM chains are looked up by `chainId`, Solana clusters
 * (whose `chainId` is nominal) by `network`.
 */
export interface RpcResolvableChain {
  network: string;
  rpcs: RpcEndpointLike[];
  chainId?: number;
  architecture?: string;
}

/**
 * Free public endpoints, used when neither the host's map nor the config
 * yields a usable url.
 *
 * Only for the browser's occasional reads — balances, allowances, receipts.
 * These operators rate-limit and say they are not for production traffic;
 * a deployment that reads heavily, or wants its own provider, sets
 * `CHAIN_RPC_URLS`, which always wins.
 *
 * Each entry answered with its own chain id (genesis hash for Solana) AND an
 * `Access-Control-Allow-Origin` that admits a browser origin, checked
 * 2026-10-08. Left out on purpose: `api.mainnet-beta.solana.com` (403s
 * browser origins), Arc testnet's `rpc.testnet.arc.network` (403), and any
 * endpoint carrying a key.
 */
export const PUBLIC_RPC_URLS: {
  /** EVM `chainId` -> endpoint. */
  evm: Readonly<Record<number, string>>;
  /** Solana chain `network` -> endpoint. */
  solana: Readonly<Record<string, string>>;
} = {
  evm: {
    // Mainnets
    1: "https://ethereum-rpc.publicnode.com",
    14: "https://flare-api.flare.network/ext/C/rpc",
    999: "https://rpc.hyperliquid.xyz/evm",
    4663: "https://rpc.mainnet.chain.robinhood.com",
    5042: "https://rpc.mainnet.arc.io",
    8453: "https://mainnet.base.org",
    42161: "https://arb1.arbitrum.io/rpc",
    // Testnets
    114: "https://coston2-api.flare.network/ext/C/rpc",
    998: "https://rpc.hyperliquid-testnet.xyz/evm",
    46630: "https://rpc.testnet.chain.robinhood.com",
    84532: "https://sepolia.base.org",
    421614: "https://sepolia-rollup.arbitrum.io/rpc",
    11155111: "https://ethereum-sepolia-rpc.publicnode.com",
    11155420: "https://sepolia.optimism.io",
  },
  solana: {
    "solana-mainnet": "https://solana-rpc.publicnode.com",
    "solana-devnet": "https://api.devnet.solana.com",
  },
};

/**
 * The {@link PUBLIC_RPC_URLS} entry for `chain`, or `null` when it has none.
 *
 * A Solana chain is matched by `network` only, never by its nominal
 * `chainId`, so it cannot pick up an EVM chain's endpoint.
 */
export function publicRpcUrl(chain: RpcResolvableChain): string | null {
  const solana = PUBLIC_RPC_URLS.solana[chain.network];
  if (solana) return solana;
  if (chain.architecture?.toLowerCase() === "solana") return null;
  if (!chain.chainId) return null;
  return PUBLIC_RPC_URLS.evm[chain.chainId] ?? null;
}

/**
 * The url of the first ENABLED entry in `chain.rpcs` (priority order), or
 * `""` when there is none (an empty or all-disabled set).
 *
 * Mirrors the sdk crate's `primary_endpoint_url` convention
 * (`sdk/aspens/src/chain_client.rs`) and the arborter's own
 * `primary_rpc_url`/`resolved_rpcs`, so every consumer of `Chain.rpcs` agrees
 * on which endpoint is "the" one for a chain with several configured.
 */
export function primaryEndpointUrl(chain: { rpcs: RpcEndpointLike[] }): string {
  return chain.rpcs.find((rpc) => rpc.enabled)?.url ?? "";
}

/** A `chain.network` -> endpoint map, as supplied by the host application. */
export type RpcUrlMap = Record<string, string>;

/**
 * Whether `url` is something we can actually dial. Rejects:
 *   - blanks,
 *   - the whole-string arborter mask, substituted for a url it cannot parse
 *     (any all-asterisk run, so a mask of a different length still fails
 *     closed),
 *   - the partial mask: the arborter sentinel-writes the literal substring
 *     `***` into every masked query value, userinfo, and non-empty path
 *     segment of a parseable url, so any url containing that substring
 *     anywhere is treated as masked. Same check as infra's `redacted()`
 *     (`infra/deployer/internal/venue/resources.go`) — a url that happens to
 *     contain a genuine, never-masked `***` is a false positive this accepts
 *     on purpose: failing closed (treat as unusable) beats dialing a masked
 *     value,
 *   - anything that isn't http(s).
 */
export function isUsableRpcUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (trimmed === "") return false;
  if (/^\*+$/.test(trimmed)) return false;
  if (trimmed.includes("***")) return false;
  return /^https?:\/\/./i.test(trimmed);
}

/**
 * Endpoint for `chain`, or `null` when none is usable.
 *
 * Precedence: the caller's override for `chain.network`, then the config's
 * own first-enabled `rpcs` entry ([`primaryEndpointUrl`]), then the static
 * public endpoint ([`publicRpcUrl`]). An unusable override falls through
 * rather than being dialed.
 */
export function resolveRpcUrl(
  chain: RpcResolvableChain,
  overrides: RpcUrlMap | undefined,
): string | null {
  const override = overrides?.[chain.network];
  if (isUsableRpcUrl(override)) return override!.trim();
  const configUrl = primaryEndpointUrl(chain);
  if (isUsableRpcUrl(configUrl)) return configUrl.trim();
  return publicRpcUrl(chain);
}

/**
 * Parse a JSON `{"<network>": "<url>"}` string into an {@link RpcUrlMap}.
 *
 * Tolerant by design — this reads deployment configuration, and a malformed
 * value must not take the whole terminal down. Malformed input yields an empty
 * map (every chain then falls back to its config url, and unusable ones are
 * skipped and reported by the caller); individual entries that aren't usable
 * URLs are dropped.
 */
export function parseRpcUrlMap(raw: string | undefined | null): RpcUrlMap {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: RpcUrlMap = {};
  for (const [network, url] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof url === "string" && isUsableRpcUrl(url))
      out[network] = url.trim();
  }
  return out;
}
