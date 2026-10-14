# @aspensprotocol/sdk-ts

TypeScript gRPC-Web client for the Aspens arborter: market config, order encoding and signing
(EIP-191 / Ed25519), order submission and cancellation, order-id verification, orderbook and
trade streams, balances, settlement-address resolution, Solana instructions, and decimals
handling. No React dependency. See `CHANGELOG.md` for what changed in each release.

The generated protobuf types under `src/protos/` arrive from the `protos` repo's `sync-protos`
fan-out; do not edit them by hand.

## Installing

The package is published to GitHub Packages, which requires authentication even to read. In
the consuming project, add an `.npmrc`:

```ini
@aspensprotocol:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` is a personal access token (classic) with `read:packages` locally. In GitHub
Actions, use the workflow's `secrets.GITHUB_TOKEN` with `permissions: packages: read`; a
repository other than `aspensprotocol/terminal-ui` also needs read access granted under the
package's settings ("Manage Actions access").

```bash
bun add @aspensprotocol/sdk-ts
```

The build emits ES modules with extensionless relative imports in places, so consume it
through a bundler (Next.js, Vite, …) rather than plain Node ESM.

## Usage

### Clients and transports

Each `ExchangeClient` owns its transport: a gRPC-Web transport to `grpcUrl`, or any connect-es
`Transport` passed as `grpcTransport` (an in-memory `createRouterTransport` in tests, for
example). Two clients never share or redirect each other's.

```ts
import { ExchangeClient } from "@aspensprotocol/sdk-ts";

const client = new ExchangeClient({ grpcUrl: "https://venue.example/api" });
const markets = await client.getMarkets(); // throws if the venue cannot be reached
```

`getMarkets` / `getTokens` throw on a configuration failure. Stub markets are served only with
`allowStubData: true`, for demos.

The raw service clients are `client.grpc.arborterClient` / `client.grpc.configClient`, or
`createArborterClient(transport)` / `createConfigClient(transport)` standalone.

### Streams

`streamTrades` / `streamOrderbook` yield the proto messages of one call. Aborting the signal, or
breaking out of the loop, cancels the request:

```ts
const abort = new AbortController();
for await (const trade of client.streamTrades(
  { marketId, historical: true },
  { signal: abort.signal },
)) {
  // trade.orderHit, trade.buyerIs, trade.timestamp (bigint), …
}
```

`subscribeTrades` / `subscribeOrderbook` reconnect with jittered exponential backoff (1 s to
30 s) and request the full history on every connect. They yield events rather than throwing:

```ts
for await (const event of client.subscribeTrades({ marketId }, { signal })) {
  switch (event.type) {
    case "connected": // a history replay starts here
    case "trade": // event.trade
    case "disconnected": // event.reason, event.retryInMs
    case "error": // a refusal retrying cannot fix; the subscription has ended
  }
}
```

Nothing is deduplicated: each reconnect replays the history, and two identical prints are both
real. Reconcile replays with `tradeKey(trade)` plus an occurrence count per key. A quiet market
may send no response at all — not even headers — until its first print; that is reported as no
`connected` event yet, never as a failure.

### Fills and trade fields

`placeOrder` returns `orderInBook` and `trades`, the order's exact arrival fills. Trades adapted
from gRPC (`VenueTrade`) carry `marketId`, `timestampMs`, `priceRaw`, `qtyRaw` (pair units),
`buyerIs` / `sellerIs`, the four maker/taker addresses and `orderHit` (`""` when the venue
redacted a hidden maker).

### Order terms and id verification

Counterparties exchange an order's terms as one line, `aspens-otc:v1:<base64url(JSON)>`, with
JSON keys `market_id`, `side` (`"BID"` / `"ASK"`), `qty`, `price` (pair units), `nonce`, `owner`
(the lock-side account) and `id`:

```ts
const terms = decodeTermsBlock(line); // throws on any malformed block
const check = verifyOrderId(terms, client.cache.getConfig()!);
if (!check.ok) throw new Error(check.reason);
```

`verifyOrderId` recomputes the id with the same recipe `placeOrder` callers use
(`buildOrderCommitment`) and compares it exactly. The id hashes amounts in each token's native
units, so a qty or price that differs only below the tokens' precision derives the same id; compare
the pair-unit strings against the agreed ticket as well. `orderIdPreimage` returns the hashed bytes
for diagnosing a mismatch.

## Releasing

1. Bump `version` in `package.json` and merge to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag sdk-v0.2.0 && git push origin sdk-v0.2.0
   ```

`.github/workflows/publish-sdk.yml` checks that the tag matches `package.json`, runs the tests,
builds, and publishes. A version can be published only once.
