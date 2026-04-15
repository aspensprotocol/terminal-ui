<div align="center">

# Aspens Terminal UI

A full terminal UI for trading on an Aspens Market Stack.

</div>

## Project Structure

```
terminal-ui/
├── ui/                        # Next.js 16 trading interface (React 19, Tailwind 4)
├── packages/
│   └── sdk-typescript/        # Internal gRPC-Web client for the arborter
├── Dockerfile                 # Multi-stage Bun build
├── justfile                   # Common dev commands
└── LICENSE                    # GPL-3.0
```

The UI is a single Next.js app that talks to the **arborter** gRPC stack
(a separate repo) over gRPC-Web. All trading state — orderbook, trades,
config, orders — comes from that backend. There is no local server in
this repo.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (pinned via `.bun-version`)
- [Just](https://github.com/casey/just) (optional; the `justfile` wraps the common bun commands)
- [Docker](https://www.docker.com/) — optional, if you want to build and run the container image directly
- A running arborter instance (local or remote) to point the UI at

### Install and run

```bash
bun install                   # workspace-aware install
bun run dev                   # or `just dev` — starts `next dev` in ui/
```

The app serves at http://localhost:3000 by default.

### Build

```bash
bun run build:sdk             # compile the TypeScript SDK first
bun run build                 # then build the Next.js app
```

### Docker

```bash
docker build -t aspens-terminal-ui .
docker run --rm -p 3000:3000 aspens-terminal-ui
```

The multi-stage `Dockerfile` produces a slim Bun runtime image serving
the built Next.js app on port 3000.

## Environment Variables

The UI is a client-side bundle; all public config is prefixed with
`NEXT_PUBLIC_` and baked in at build time.

| Variable                               | Default                | Purpose                                       |
| -------------------------------------- | ---------------------- | --------------------------------------------- |
| `NEXT_PUBLIC_GRPC_URL`                 | `/api` (Next.js proxy) | Arborter gRPC-Web endpoint                    |
| `NEXT_PUBLIC_SOLANA_RPC_URL`           | devnet                 | Solana RPC used by the wallet-adapter context |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | fallback               | WalletConnect / Reown project id              |

Additional vars (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`,
`NEXT_PUBLIC_ORGANIZATION_ID`, `NEXT_PUBLIC_AUTH_PROXY_CONFIG_ID`) are
consumed by optional integrations (embedded-wallet auth, REST shim) —
see `ui/.env.example` for the full list.

## Architecture

### UI (`ui/`)

Next.js 16 + React 19 + TypeScript + Tailwind CSS 4.

- **State**: Zustand + immer; React Query for server state
- **Tables / layout**: TanStack React Table, Radix UI primitives, Framer Motion
- **Charting**: TradingView Advanced Charts (vendored assets under `ui/public/vendor/trading-view/`)
- **Wallets**:
  - **EVM** via `wagmi` / `viem` / `@reown/appkit` (WalletConnect, MetaMask, injected)
  - **Solana** via `@solana/wallet-adapter-react` / `@solana/web3.js`
  - Per-market dispatch picks the ecosystem matching the chain's
    `architecture` field from the arborter config

### TypeScript SDK (`packages/sdk-typescript/`)

Internal gRPC-Web client for the arborter backend, with generated
protobuf types. Consumed by the UI only; not published.

- **Transport**: `@connectrpc/connect` + `@connectrpc/connect-web`
- **Protobuf runtime**: `@bufbuild/protobuf`
- **Generated stubs**: `src/protos/arborter_pb.ts`,
  `arborter_config_pb.ts`, `attestation_pb.ts`
- **Services**: `ArborterService` (sendOrder, cancelOrder, streaming
  orderbook / trades), `ConfigService` (getConfig)

Consumed by the UI as a `workspace:*` dependency.

## Available `just` commands

```bash
just                          # list all recipes
just install                  # bun install
just dev                      # bun run dev (Next.js dev server)
just build                    # bun run build (SDK + UI)
just build-sdk                # bun run build:sdk (SDK only)
just fmt                      # bun run format
just lint                     # bun run lint
just typecheck                # bun run typecheck
just clean                    # bun run clean
just ci                       # install + build-sdk + fmt + lint + typecheck
```

## License

This project is licensed under the GNU General Public License v3.0. See
the [LICENSE](LICENSE) file for details.
