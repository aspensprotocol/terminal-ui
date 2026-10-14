# Changelog — @aspensprotocol/sdk-ts

## 0.2.0

### Added

- **Server streams as async iterables.** `streamTrades(params, opts)` and
  `streamOrderbook(params, opts)` yield the `Trade` / `OrderbookEntry` messages
  exactly as sent. `params` is `{ marketId, historical?, filterByTrader? }`;
  `opts.signal` aborts the underlying request (also while it is still waiting
  for response headers) and ends iteration quietly, as does breaking out of the
  loop.
- **Reconnecting subscriptions.** `subscribeTrades` / `subscribeOrderbook`
  reconnect with jittered exponential backoff (1 s → 30 s, reset after a
  healthy connection), request the full history on every connect, and yield
  typed events: `connected`, `trade` / `entry`, `disconnected` (with reason,
  status code and retry delay) and a terminal `error` for refusals retrying
  cannot fix. A stream that sends nothing — not even headers, as a quiet market
  does — is treated as waiting, never as a failure.
- **Raw service clients and transports.** `createGrpcTransport`,
  `createArborterClient`, `createConfigClient`, `createGrpcServices`,
  `getDefaultTransport`, the `ArborterService` / `ConfigService` descriptors
  and the `Transport`, `Trade` and `OrderbookEntry` types.
- **Per-client transport.** `ExchangeClientConfig.grpcTransport` injects any
  connect-es `Transport`; without it each client builds its own gRPC-Web
  transport to `grpcUrl`. `client.grpc` exposes the client's raw service
  clients, and `client.streamTrades` / `streamOrderbook` / `subscribeTrades` /
  `subscribeOrderbook` stream over it.
- **Order-id verification and terms blocks.** `orderIdPreimage(opts)` returns
  the exact bytes the order id hashes (and `encodeOrderIdPreimage` the
  low-level form); `verifyOrderId(terms, config)` recomputes an id from
  `{market_id, side, qty, price, nonce, owner}` and the venue configuration and
  compares it exactly; `encodeTermsBlock` / `decodeTermsBlock` handle the
  one-line `aspens-otc:v1:<base64url(JSON)>` format, refusing any malformed
  block.
- **Raw trade fields.** Trades adapted from gRPC (`toEnhancedTrade`) are now
  `VenueTrade`s, which add `marketId`, `timestampMs` (bigint), `priceRaw`,
  `qtyRaw`, `buyerIs`, `sellerIs`, `orderHit` (`0x` hex, `""` when redacted)
  and the four maker/taker addresses to the existing fields. `tradeKey(trade)`
  gives a print's identity for replay reconciliation.
- **`placeOrder` returns the venue's answer**: the result (`PlacedOrder`)
  carries `orderInBook` and `trades` — the adapted `SendOrderResponse.trades`,
  the order's exact arrival fills.

### Changed

- **`getMarkets` / `getTokens` throw when the configuration cannot be
  fetched**, instead of silently returning stub markets. A venue with no
  markets yields `[]`. The previous fallback is available behind
  `ExchangeClientConfig.allowStubData`.
- **Constructing an `ExchangeClient` no longer touches the module-wide default
  transport.** It used to call `setGrpcBaseUrl(grpcUrl)` and `resetTransport()`;
  code that relied on that to point the default transport somewhere must now
  call `setGrpcBaseUrl` itself.
- The polling reads (`getTrades`, `getOrders`, `onTrades`, `onOrderbook`) cancel
  the server stream once they have collected the history, rather than leaving
  the request open.

## 0.1.0

First published release.
