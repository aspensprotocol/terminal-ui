"use client";

/**
 * Whether this deployment routes through the FCE ext-proxy.
 *
 * A BOOLEAN is all that crosses the server/client boundary. `EXT_PROXY_URL` and
 * `DIRECT_API_KEY` stay on the server — the browser only ever calls the
 * same-origin `/fce-proxy` relay, which injects the key. Passing either value
 * through here would put it in the client bundle.
 */

import { createContext, useContext } from "react";

const FceContext = createContext(false);

export function FceProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return <FceContext.Provider value={enabled}>{children}</FceContext.Provider>;
}

export function useFceEnabled(): boolean {
  return useContext(FceContext);
}
