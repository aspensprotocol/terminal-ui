## Project Overview

Trading terminal UI for **Aspens**, a cross-chain cryptocurrency exchange. Markets are trading pairs where the base and quote tokens can live on different blockchain networks (e.g. fXRP on flare-coston2 vs USDT0 on flare-coston2-quote). The backend matching engine is called **arborter**.

- **UI**: Next.js (App Router) with TypeScript, React 19
- **SDK**: `@exchange/sdk` — TypeScript gRPC-Web client for arborter
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
│   └── sdk-typescript/        # @exchange/sdk — gRPC-Web client for arborter
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
- **Prod**: Envoy runs as a Docker Swarm service, config in `../infra/stacks/`

### gRPC Services

| Service | Purpose |
|---------|---------|
| `ConfigService.GetConfig` | Returns chains, tokens, and markets |
| `ArborterService.SendOrder` / `CancelOrder` | Order management |
| `ArborterService.Orderbook` | Server-streaming orderbook entries |
| `ArborterService.Trades` | Server-streaming trade history |
| `AuthService` | JWT auth (admin-console only) |

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

| File | Purpose |
|------|---------|
| `ui/src/lib/store.ts` | Zustand store — markets, orderbook, trades, wallet state |
| `ui/src/lib/api.ts` | `getExchangeClient()` singleton |
| `ui/src/lib/signing-adapter.ts` | Signing for order submission |
| `ui/src/lib/wallet/` | Multi-wallet adapter abstraction |
| `ui/src/lib/providers/` | React context providers |
| `ui/src/components/trade-panel/hooks/useTradeFormSubmit.ts` | Trade form submission logic |
| `packages/sdk-typescript/src/grpc-transport.ts` | gRPC-Web transport + service clients |
| `packages/sdk-typescript/src/client.ts` | `ExchangeClient` — markets, orders, orderbook polling |
| `ui/.env.local` | `NEXT_PUBLIC_GRPC_URL=http://localhost:8811` |

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

### Envoy Proxy (local)

Config: `../infra/stacks/local/envoy.yaml` — listens on port 8811, proxies gRPC-Web to arborter on port 50051 via `host.docker.internal`. CORS allows headers needed by Connect RPC: `content-type, x-grpc-web, x-user-agent, grpc-timeout, authorization, connect-protocol-version, connect-timeout-ms`.
