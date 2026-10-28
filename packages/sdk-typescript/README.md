# @aspensprotocol/sdk-ts

TypeScript gRPC-Web client for the Aspens arborter: market config, order encoding and signing
(EIP-191 / Ed25519), order submission and cancellation, order-id verification, orderbook and
trade streams, balances, settlement-address resolution, Solana instructions, EVM deposit and
withdrawal calls, settlement evidence and fee rates on both chains, and decimals handling. No React dependency. See `CHANGELOG.md` for what changed in each release.

The generated protobuf types under `src/protos/` arrive from the `protos` repo's `sync-protos`
fan-out; do not edit them by hand.

## Installing

The package is published to npmjs, public, with provenance; installing needs no token.

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

### Signing per chain architecture

`signOrder` and `signCancelOrder` take the `Chain.architecture` of the chain the order gives on
(`givingArchitecture(market, side)`: a buy gives quote, a sell gives base), and sign under that
chain's scheme. `"EVM"` and `"Solana"` call the adapter's `signMessage` with the
encoded message as `0x` hex. `"Tron"` calls `signTronMessage` with the lowercase hex TEXT of the
encoded message (no `0x`), signed under the TRON message prefix; an adapter without it is refused.
An unknown architecture throws (`parseArchitecture`). `privateKeyTronAdapter(key)` is a Tron adapter
over a raw key, for services.

Tron accounts are `0x` hex everywhere the venue sees them. Convert a `T…` address at the input edge
with `tronToHex`, and back for display with `hexToTron`.

### Sessions and nonces (replay protection)

Every order carries the venue session and a nonce, both signed:

```ts
const nonce = clientNonce(); // max(unix millis, last + 1)
const session = await client.currentSession();
// Signed for the chain the order gives on (a buy gives quote).
const signature = await signOrder(
  { ...order, nonce, session },
  adapter,
  givingArchitecture(market, order.side),
);
await client.placeOrder({ ...params, nonce, session, signature });
```

The arborter opens a new session every time it starts and refuses an order signed for any other
one ("session changed"); call `client.currentSession(true)` and sign a NEW order. Within a session
it admits each signer's nonce once, and only above the lowest of that signer's 32 highest used
nonces, so a re-sent signed order is refused as a replay (`ALREADY_EXISTS`) whatever became of the
first. Never re-send signed bytes.

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

### Deposits and withdrawals (EVM)

The builders return `writeContract` parameters; nothing is signed or sent:

```ts
await walletClient.writeContract(
  evmApproveCall({ token, spender: midrib, amount }),
);
await walletClient.writeContract(
  evmDepositCall({ contract: midrib, token, amount }),
);

const message = withdrawRequestMessage({ network, token, account, amount });
const signature = await walletClient.signMessage({ account, message }); // EIP-191
const voucher = await client.requestWithdrawVoucher({
  network,
  token,
  account,
  amount: amount.toString(),
  signature: hexToBytes(signature),
});
await walletClient.writeContract(
  evmWithdrawCall({ contract: midrib, voucher }),
);
```

The native asset uses `evmDepositNativeCall` and needs no approval. Solana deposits and
withdrawals use `depositIx` / `buildWithdrawVoucherIxs`; the request text is the same
`withdrawRequestMessage`, signed as raw Ed25519 over its UTF-8 bytes.

### Deposits and withdrawals (Tron)

Tron writes are native Tron transactions sent by the SDK itself; the adapter only signs
(`signTronTransaction`). Each one resolves only on a `SUCCESS` receipt and throws a
`TronTxError` otherwise (`err.sent` says whether anything was broadcast):

```ts
const node = { urls: ["https://nile.trongrid.io"], apiKey }; // apiKey optional
const sender = { node, adapter, owner: tronToHex(walletAddress) };

await tronDeposit({ ...sender, contract: midrib, token: usdt, amount }); // approve if short, then deposit
await tronDepositNative({ ...sender, contract: midrib, amount: sun }); // TRX, no approve

const message = withdrawRequestMessage({
  network,
  token,
  account: sender.owner,
  amount,
});
const signature = await adapter.signTronMessage!(message);
const voucher = await client.requestWithdrawVoucher({
  /* as on EVM */
});
await tronWithdraw({ ...sender, contract: midrib, voucher });
```

Reads use the EVM code: `publicClientFor(chain, rpcUrls)` on a Tron chain (or
`tronPublicClient(node)`) is a viem client at the node's `/jsonrpc`.

### Settlement evidence

EVM: `readMidribEvents(publicClient, { contract, account, fromBlock, toBlock })` returns the
account's `NetSettled`, `TokenDeposited` and `Withdrawn` logs, decoded, with `txHash`, `logIndex`
and `blockNumber`. A failed chunk rejects the whole read; retry the range.

Solana: deposits emit no event, so watch `deposited` on the UserBalance account as well.

```ts
const scan = await readMidribSolanaEvents(connection, {
  programId,
  instance,
  user,
  mint,
  until,
});
// scan.events: NetSettled / Withdrawn, oldest first; scan.newestSignature: the next `until`;
// scan.incomplete: transactions whose logs were truncated.
const balance = await readUserBalance(connection, {
  programId,
  instance,
  user,
  mint,
});
```

### Fees

```ts
const { maintenanceBps, operatorBps } = await readEvmFeeRates(
  publicClient,
  midrib,
);
// or: await readSolanaFeeRates(connection, { programId, instance })
const fee = feeForVolume(grossTakerVolume, maintenanceBps, operatorBps);
```

`feeForVolume` floors the two rates separately, as the contracts do; that can be one base unit
less than flooring their sum.

## Releasing

1. Bump `version` in `package.json` and merge to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag sdk-v0.5.0 && git push origin sdk-v0.5.0
   ```

`.github/workflows/publish-sdk.yml` checks that the tag matches `package.json`, runs the tests,
builds, and publishes to npmjs. A version can be published only once.

The workflow authenticates with npm trusted publishing (configured on the package's npmjs
settings for this repository and `publish-sdk.yml`) or, before that is set up, the `NPM_TOKEN`
repository secret.
