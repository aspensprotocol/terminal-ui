# Changelog — @aspensprotocol/sdk-ts

## 0.4.0

### Changed (breaking)

- **Orders carry the venue session.** `OrderSigningData.session` and
  `PlaceOrderParams.session` are required: the arborter opens a new session
  every time it starts and refuses an order for any other one ("session
  changed"), so nothing signed before a restart is placed after it. Read it
  with `client.currentSession()`; after a "session changed" refusal call
  `client.currentSession(true)` and sign a new order.
- **`clientNonce()` returns `max(unix millis, last + 1)`.** The arborter now
  admits each signer's nonce once per session, and only above the lowest of
  its 32 highest used nonces; a repeated or too-low nonce is refused as a
  replay. Nonces must therefore increase.

### Added

- `ExchangeClient.currentSession(refresh?)`.

### Removed

- **`EnhancedOrderbookLevel.postOnly`.** Whether a resting order is post-only
  is its creator's business, not the book's; the orderbook adapters no longer
  copy it from the wire. Order entry's own `postOnly` option is unchanged.

## 0.3.0

### Added

- **MidribV3 without React.** `MIDRIB_V3_ABI` and `ERC20_APPROVAL_ABI`; the
  write-call builders `evmApproveCall`, `evmDepositCall`,
  `evmDepositNativeCall` and `evmWithdrawCall(voucher)`, whose results go
  straight into viem / wagmi `writeContract` or `encodeFunctionData`;
  `withdrawRequestMessage({ network, token, account, amount })`, the canonical
  `"<network>|<token>|<account>|<amount>"` text a withdrawal request is signed
  over; and `midribRevertName(err)`, the custom-error name of a reverted call.
- **EVM settlement evidence.** `decodeMidribLog` decodes MidribV3's
  `NetSettled`, `TokenDeposited` and `Withdrawn` logs (topic0s exported as
  `NET_SETTLED_TOPIC`, `TOKEN_DEPOSITED_TOPIC`, `WITHDRAWN_TOPIC`).
  `readMidribEvents(client, { contract, account, fromBlock, toBlock,
chunkSize? })` fetches all three for one account, filtered on the indexed
  account topic, in 2000-block chunks by default, in chain order.
  `readTradeBalance(client, contract, holder, token)`.
- **Solana settlement evidence.** `decodeMidribEventData` and
  `parseMidribLogs(logs, programId)` decode the program's Anchor `NetSettled`
  and `Withdrawn` events from `Program data:` lines, accepting only lines the
  midrib program itself logged. `readMidribSolanaEvents(connection, { programId,
instance, user, mint, until?, before? })` walks the UserBalance account's
  signatures and returns the account's events oldest first, with the newest
  signature for the next read and any transactions whose logs were truncated.
  `decodeUserBalance` / `readUserBalance` return `deposited` and `locked`;
  `deriveUserBalancePda` is now exported.
- **Fee rates and the fee formula.** `readEvmFeeRates(client, contract)` reads
  MidribV3 `maintenanceBps()` / `operatorBps()`; `decodeTradingInstanceFees` /
  `readSolanaFeeRates(connection, { programId, instance })` read
  `maintenance_bps` / `operator_bps` from the Solana `TradingInstance`
  account. `feeForVolume(gross, maintenanceBps, operatorBps)` computes the
  contracts' fee, `floor(G × m / 10000) + floor(G × o / 10000)`, flooring the
  two rates separately as the contracts do.

### Changed

- The balances reads use `readTradeBalance`; results are unchanged.

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
