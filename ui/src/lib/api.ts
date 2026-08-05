/**
 * Exchange API client singleton
 *
 * Uses gRPC-Web to connect to the Arborter backend
 */

"use client";

import { ExchangeClient } from "@aspens/terminal-sdk";

let _exchange: ExchangeClient | null = null;

/**
 * Get or create the singleton ExchangeClient instance.
 * Lazily initializes to avoid SSR issues with environment variables.
 */
export function getExchangeClient(fceEnabled = false): ExchangeClient {
  if (!_exchange) {
    // Get the gRPC URL from environment variables
    // Falls back to /api which can be proxied by Next.js
    const grpcUrl =
      typeof window !== "undefined"
        ? (window as Window & { __NEXT_PUBLIC_GRPC_URL__?: string })
            .__NEXT_PUBLIC_GRPC_URL__ ||
          process.env.NEXT_PUBLIC_GRPC_URL ||
          "/api"
        : "/api";
    // FCE routes actions AND config discovery through the ext-proxy, so the
    // client needs no arborter gRPC reachability. `proxyUrl` is the SAME-ORIGIN
    // relay in app/fce-proxy — the real URL and the API key stay on the server
    // and never enter this bundle.
    //
    // `grpcUrl` is still passed: it is required by the constructor and is
    // simply unused on the FCE path.
    _exchange = fceEnabled
      ? new ExchangeClient({
          grpcUrl,
          transport: "fce",
          fce: {
            proxyUrl: "/fce-proxy",
            pollIntervalMs: 500,
            pollAttempts: 60,
          },
        })
      : new ExchangeClient({ grpcUrl });
  }
  return _exchange;
}

/**
 * Reset the exchange client (useful for testing or when URL changes)
 */
export function resetExchangeClient(): void {
  if (_exchange) {
    _exchange.disconnect();
    _exchange = null;
  }
}
