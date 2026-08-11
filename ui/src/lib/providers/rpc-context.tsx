"use client";

/**
 * Per-chain RPC endpoints the BROWSER may dial.
 *
 * The arborter masks every `rpc_url` in its `GetConfig` response, so the
 * `Configuration` the client receives carries `"********"` and nothing
 * chain-side can be read from it. This context carries the replacement map,
 * read from the server env at request time in `app/layout.tsx`.
 *
 * Unlike `EXT_PROXY_URL` / `DIRECT_API_KEY` — which stay server-side behind
 * the /fce-proxy relay — these values ARE handed to the browser, because the
 * browser is what dials them. Configure PUBLIC endpoints only: anything put
 * here is visible in the page payload. That constraint is why the durable fix
 * is a non-secret `public_rpc_url` on the chain config itself (RPC-MASK-1).
 */

import { createContext, useContext } from "react";
import type { RpcUrlMap } from "@aspens/terminal-sdk";

const EMPTY: RpcUrlMap = {};

const RpcUrlsContext = createContext<RpcUrlMap>(EMPTY);

export function RpcUrlsProvider({
  rpcUrls,
  children,
}: {
  rpcUrls: RpcUrlMap;
  children: React.ReactNode;
}) {
  return (
    <RpcUrlsContext.Provider value={rpcUrls}>
      {children}
    </RpcUrlsContext.Provider>
  );
}

/** `chain.network` -> endpoint. Empty when the deployment configured none. */
export function useRpcUrls(): RpcUrlMap {
  return useContext(RpcUrlsContext);
}
