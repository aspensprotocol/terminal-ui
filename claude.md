## Project Overview

Trading terminal UI for **Aspens**, a cross-chain cryptocurrency exchange. Markets are trading pairs where the base and quote tokens can live on different blockchain networks (e.g. fXRP on flare-coston2 vs USDT0 on flare-coston2-quote). The backend matching engine is called **arborter**.

- **UI**: Next.js (App Router) with TypeScript, React 19
- **SDK**: `@aspens/terminal-sdk` — TypeScript gRPC-Web client for arborter
- **State**: Zustand with immer middleware
- **Wallet**: wagmi (EVM), multi-wallet adapter abstraction
- **Charts**: TradingView charting library

## Project Structure

```
terminal-ui/
├── ui/                        # Next.js React app
│   ├── src/
│   │   ├── app/               # Next.js app router pages
│   │   ├── components/        # React components (orderbook, trade panel, chart, etc.)
│   │   └── lib/               # Store, hooks, wallet adapters, API client
│   └── public/vendor/trading-view/  # TradingView charting library
├── packages/
│   └── sdk-typescript/        # @aspens/terminal-sdk — gRPC-Web client for arborter
│       └── src/
│           ├── protos/        # Generated protobuf types (protoc-gen-es v2)
│           ├── adapters/      # Convert protobuf → SDK types (markets, orderbook, trades)
│           ├── grpc-transport.ts  # Connect RPC gRPC-Web transport
│           ├── client.ts      # ExchangeClient class
│           └── types.ts       # Market, Token, Order, Trade types
└── justfile                   # Build commands
```

## API Architecture

All communication with arborter uses **gRPC-Web** via the Connect RPC library (`@connectrpc/connect-web`). There is no REST API or WebSocket — the SDK polls gRPC streaming endpoints.

- **Envoy proxy** translates gRPC-Web (browser) → native gRPC (arborter on port 50051)
- **Dev**: UI connects directly to Envoy at `http://localhost:8811` via `NEXT_PUBLIC_GRPC_URL`
- **Prod**: Envoy runs as a Docker Swarm service, config in `../infra/stacks/`. The
  SDK falls back to the same-origin `/api/*` path when `NEXT_PUBLIC_GRPC_URL` is
  unset; `ui/next.config.ts` rewrites `/api/*` to the in-swarm `http://envoy:8811`
  with that destination hardcoded — no env var is read at build or runtime, so a
  stray `.env.local` cannot poison the published image.

### gRPC Services

| Service                                     | Purpose                             |
| ------------------------------------------- | ----------------------------------- |
| `ConfigService.GetConfig`                   | Returns chains, tokens, and markets |
| `ArborterService.SendOrder` / `CancelOrder` | Order management                    |
| `ArborterService.Orderbook`                 | Server-streaming orderbook entries  |
| `ArborterService.Trades`                    | Server-streaming trade history      |
| `AuthService`                               | JWT auth (admin-console only)       |

### Cross-chain Market Model

A market pairs a base token on one chain with a quote token on another:

```
Market {
  id: "network-a::0xBaseToken::network-b::0xQuoteToken"  // full market ID
  base_ticker: "fXRP"           // base token symbol
  quote_ticker: "USDT0"         // quote token symbol
  baseChainNetwork: "flare-coston2"
  quoteChainNetwork: "flare-coston2-quote"
  pairDecimals: 18              // precision for price/size
}
```

## Key Files

| File                                                        | Purpose                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `ui/src/lib/store.ts`                                       | Zustand store — markets, orderbook, trades, wallet state |
| `ui/src/lib/api.ts`                                         | `getExchangeClient()` singleton                          |
| `ui/src/lib/signing-adapter.ts`                             | Signing for order submission                             |
| `ui/src/lib/wallet/`                                        | Multi-wallet adapter abstraction                         |
| `ui/src/lib/providers/`                                     | React context providers                                  |
| `ui/src/components/trade-panel/hooks/useTradeFormSubmit.ts` | Trade form submission logic                              |
| `packages/sdk-typescript/src/grpc-transport.ts`             | gRPC-Web transport + service clients                     |
| `packages/sdk-typescript/src/client.ts`                     | `ExchangeClient` — markets, orders, orderbook polling    |
| `ui/.env.local`                                             | `NEXT_PUBLIC_GRPC_URL=http://localhost:8811`             |

## Development

```bash
just ui          # Start Next.js dev server
just install     # Install all dependencies (bun)
just build-sdk   # Build the SDK package
just fmt         # Format code
just lint        # Lint code
just typecheck   # TypeScript type checking
just ci          # Full CI pipeline (install, build, fmt, lint, typecheck)
```

### Type Generation

Protobuf types in `packages/sdk-typescript/src/protos/` are generated from arborter's `.proto` files using `protoc-gen-es v2`. The SDK adapters in `packages/sdk-typescript/src/adapters/` convert protobuf types to the SDK's `Market`, `Token`, `EnhancedTrade`, etc.

### Dev server against a DEPLOYED stack (validated 2026-08-25 against a live testnet stack)

Endpoint facts that cost time to rediscover:

- The browser-facing **gRPC-Web** endpoint of a deployed stack is the main
  domain's `/api/*` path (`https://<stack-domain>/api`). The
  `grpc.<stack>` subdomain is **native gRPC** — gRPC-Web POSTs to it return
  404. Do not point `NEXT_PUBLIC_GRPC_URL` at either one directly.
- The deployed front proxy answers CORS for **its own origin only**, so a
  `localhost:3000` dev server is blocked on preflight. Run a local CORS
  proxy and point the dev server at that instead.
- Port **8811 is usually taken locally** (the local-rig Envoy under
  OrbStack/Docker); use another port for the proxy.

Recipe:

```bash
# 1. CORS proxy (any scratch dir). NODE_TLS_REJECT_UNAUTHORIZED=0 is needed
#    because Bun's fetch rejects the stack's TLS chain that curl accepts.
cat > /tmp/cors-proxy.ts <<'EOF'
const UPSTREAM = "https://<stack-domain>/api"; // <- your stack's main domain
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, x-grpc-web, x-user-agent, grpc-timeout, authorization, connect-protocol-version, connect-timeout-ms",
  "Access-Control-Expose-Headers": "*",
};
Bun.serve({
  port: 8812,
  async fetch(req) {
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    // Strip Host/Origin (the upstream front proxy routes by Host) and
    // Content-Length (recomputed); BUFFER the request body — piping the
    // browser's stream through two hops trips the upstream's framing.
    const fwd = new Headers();
    for (const [k, v] of req.headers)
      if (!["host", "origin", "referer", "connection", "content-length"].includes(k.toLowerCase()))
        fwd.set(k, v);
    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method, headers: fwd, body,
    });
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
});
EOF
NODE_TLS_REJECT_UNAUTHORIZED=0 bun run /tmp/cors-proxy.ts &

# 2. Dev server pointed at the proxy
cd ui && NEXT_PUBLIC_GRPC_URL=http://localhost:8812 bun run dev
```

Known artifact of this setup: the console shows `[SDK] Error polling
trades: … premature EOF` — the proxy truncates the server-streaming
Trades poll on abort. The deployed UI itself has no such errors; ignore
them, or fix the proxy's streaming if they get in the way. Everything
else (GetConfig, markets, orderbook stream, order submission path) flows
cleanly.

### Envoy Proxy (local)

Config: `../infra/stacks/local/envoy.yaml` — listens on port 8811, proxies gRPC-Web to arborter on port 50051 via `host.docker.internal`. CORS allows headers needed by Connect RPC: `content-type, x-grpc-web, x-user-agent, grpc-timeout, authorization, connect-protocol-version, connect-timeout-ms`.
