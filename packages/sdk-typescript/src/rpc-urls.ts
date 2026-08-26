/**
 * RPC endpoint resolution for browser-side chain reads.
 *
 * The arborter masks every RPC endpoint's `url` in its `GetConfig` response
 * (RPC URLs commonly embed an API key — in the query string, userinfo, OR a
 * path segment for hosted providers like Alchemy/Infura — and `GetConfig` is
 * unauthenticated), so a browser client cannot dial the URL it receives in
 * `Configuration`. Callers supply their own map of `chain.network` -> endpoint
 * instead; `resolveRpcUrl` prefers that map and falls back to the config
 * value only when it is genuinely usable.
 *
 * When neither yields a usable endpoint this returns `null` so the caller can
 * SKIP the chain and say so. That is the point of the module: the previous
 * behaviour passed the mask straight to viem, every read threw, and each throw
 * was swallowed into `0n` — producing a balances panel of zeros that looked
 * exactly like "you have no deposits".
 *
 * Long term the arborter should publish a non-secret `public_rpc_url` per chain
 * so this map is unnecessary; see the RPC-MASK-1 tech-debt item.
 */

/** The fixed mask the arborter substitutes for a whole unparseable `rpc_url`. */
export const MASKED_RPC_URL = "********";

/** Minimal shape of one `chain.rpcs[n]` entry needed to pick an endpoint. */
export interface RpcEndpointLike {
  url: string;
  enabled: boolean;
}

/**
 * Minimal shape needed to resolve an endpoint — matches `Configuration.chains[n]`
 * post `Chain.rpcs` (the single-`rpc_url`-string field is gone; every chain now
 * carries a priority-ordered, per-endpoint-auth `rpcs` list).
 */
export interface RpcResolvableChain {
  network: string;
  rpcs: RpcEndpointLike[];
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
 *   - the legacy whole-string arborter mask (any all-asterisk run, so a
 *     future mask of a different length still fails closed),
 *   - the CURRENT partial mask (I-1): the arborter sentinel-writes the
 *     literal substring `***` into every masked query value, userinfo, and
 *     non-empty path segment, so any url containing that substring anywhere
 *     is treated as masked. Same check as infra's `redacted()`
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
 * own first-enabled `rpcs` entry ([`primaryEndpointUrl`]). An unusable
 * override falls through to the config value rather than being dialed.
 */
export function resolveRpcUrl(
  chain: RpcResolvableChain,
  overrides: RpcUrlMap | undefined,
): string | null {
  const override = overrides?.[chain.network];
  if (isUsableRpcUrl(override)) return override!.trim();
  const configUrl = primaryEndpointUrl(chain);
  if (isUsableRpcUrl(configUrl)) return configUrl.trim();
  return null;
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
