# Changelog — @aspensprotocol/sdk-ts

## 0.5.0 (unreleased)

### Changed (breaking)

- **`signOrder` and `signCancelOrder` take the giving leg's architecture**
  as a required third argument: the `Chain.architecture` of the chain the
  order gives on (a buy gives quote, a sell gives base). EVM and Solana legs
  sign exactly as before; a Tron leg signs with the adapter's
  `signTronMessage`; an unknown architecture throws.
- **Chain architecture is a closed set.** `"EVM"`, `"Solana"` and `"Tron"`
  (any case; empty means EVM) are read by `parseArchitecture`. Anything
  else throws where it used to be treated as EVM: `validateSettleAddress`,
  `sameSettleAddress`, `buildOrderCommitment`, `publicRpcUrl` and
  `resolveRpcUrl`. The balances fetch (`fetchChainBalanceSlices`,
  `getBalances`) does not throw: it leaves such a chain out and warns that
  its balances are OMITTED, and every other chain's balances still return.
- **`WalletBinding.ecosystem` is `Architecture`** (`"evm" | "solana" |
"tron"`), widened from `"evm" | "solana"`. An exhaustive `switch` over it
  must now handle `"tron"`.
- **`PUBLIC_RPC_URLS` gains a `tron` key** (`chainId` -> TronGrid base).
  Additive for readers; a value typed as `typeof PUBLIC_RPC_URLS` must now
  carry it.

### Migration

- Pass `givingArchitecture(market, side)` as the third argument:
  `signOrder(data, adapter, givingArchitecture(market, data.side))`, and
  the same for `signCancelOrder` with the cancelled order's side.

### Added

- **Tron.**
  - `tronToHex` / `hexToTron` convert a `T…` address at the display edge;
    the venue only ever sees `0x` hex.
  - `tronMessageDigest` is the TRON message prefix digest.
  - `buildTriggerRawData` and `tronTxId` encode a `TriggerSmartContract`
    transaction and its txID; `tronJsonRpcUrl` gives a node's `/jsonrpc`.
  - `SigningAdapter` gains optional `signTronMessage(text)` and
    `signTronTransaction(txId, rawDataHex)`; `privateKeyTronAdapter(key)`
    implements both.
  - `WalletBinding.ecosystem` accepts `"tron"`, whose balances are read
    with the EVM code at the node's `/jsonrpc`.
  - `sendTronTx` sends one `TriggerSmartContract` call over a Tron node's
    HTTP API (`TronNode`: base urls tried in order, optional
    `TRON-PRO-API-KEY`). It simulates the exact call first (a revert signs
    and sends nothing), signs once through
    `SigningAdapter.signTronTransaction`, rebroadcasts the identical hex
    when no node answers, and resolves only on a `SUCCESS` receipt. Any
    other receipt, or a broadcast refused by every node (including an HTTP
    4xx other than a 403 / 429 rate limit), throws a `TronTxError` naming
    the txID. When the transaction may have landed (unseen a block past its
    expiration, judged by the one node whose head passed it; a refusal after
    a broadcast nobody answered; the wait's backstop), the error says
    UNCONFIRMED: check the txID before retrying. Each request is abandoned
    after `TronNode.timeoutMs` (default 30 s) and counts as unanswered. `nowBlock`,
    `simulateTronCall`, `broadcastHex` and `txInfo` are the single calls.
  - `tronDeposit` (approve when the allowance is short, then `deposit`),
    `tronDepositNative` (TRX as call value, no approve) and `tronWithdraw`
    (the venue's voucher) send MidribV3's EVM calldata through
    `sendTronTx`, with a fee limit per call (`TRON_*_FEE_LIMIT_SUN`, 3x the
    energy measured on Nile). Mainnet USDT's dynamic energy factor can push
    a USDT deposit or withdraw past its limit; that fails as an
    OUT_OF_ENERGY error, never as a success.
  - `publicClientFor` gives a Tron chain a viem client at `<base>/jsonrpc`,
    and `tronPublicClient(node)` builds one from a `TronNode`, so
    `readTradeBalance`, `readEvmFeeRates`, `readMidribEvents` and
    `readEvmWalletBalance` read Tron unchanged. `publicClientFor` now
    refuses a Solana chain.
  - `PUBLIC_RPC_URLS.tron`: TronGrid's keyless bases for mainnet
    (`728126428`) and Nile (`3448148188`), used when a Tron chain's url is
    masked and no override is set.
- **`givingArchitecture(market, side)`**: the architecture of the chain an
  order gives on and is signed for.
- **`signWithdrawRequest(text, adapter, architecture)`** signs a
  `withdrawRequestMessage` the way the venue verifies it on that chain:
  EIP-191 over the text on EVM and raw Ed25519 over its bytes on Solana, as
  callers did before, and the text as is under the TRON prefix
  (`signTronMessage`) on Tron, never EIP-191. An unknown architecture throws.
- **`assertTronWithdrawTrx({ node, owner })`** throws before a Tron
  withdraw signs or requests a voucher when the account holds less than
  `TRON_MIN_TRX_FOR_WITHDRAW_SUN` (9,042,600 sun, the costliest measured
  voucher withdraw on Nile, as the Rust SDK checks), so a short wallet
  fails with nothing held.
- A Tron receipt that FAILED is read at the head, so `sendTronTx`'s error
  says it is not final yet (check the txID once solidified) instead of
  saying the transaction had no effect.

## 0.4.2

### Changed

- **Published from CI by npm trusted publishing, with provenance.** The code
  is unchanged from 0.4.1, which was published by hand without provenance.

## 0.4.1

### Changed

- **Published to npmjs** (`registry.npmjs.org`), public, with provenance.
  Installing needs no token or registry mapping. The code is unchanged from
  0.4.0, which stays on GitHub Packages only.

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
