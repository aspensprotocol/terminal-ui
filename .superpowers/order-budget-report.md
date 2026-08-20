# Order budget symmetry — terminal-ui

Status: **complete**. Branch `feat/order-budget-symmetry`, one commit `12ddc15`
(branched off `main` @ `c23c26f`). Not pushed — no credentials in this
workspace.

## What landed

### 1. Protos regenerated (the sync-protos PR had NOT arrived)

`packages/sdk-typescript/src/protos/arborter_pb.ts` still carried `amountIn`, so
it was regenerated from the workspace source of truth,
`/Users/dev/code/aspens_xyz/protos/arborter.proto` (main @ `09de11f`), with the
exact command `sync-protos.yml` runs for an `es-ts` consumer:

```
protoc --es_out=<out> --es_opt=target=ts -I . \
  arborter.proto arborter_config.proto attestation.proto
```

(`terminal-ui`'s matrix entry excludes `signer.proto` and `arborter_auth.proto`.)
Fidelity check: `arborter_config_pb.ts` and `attestation_pb.ts` regenerate
**byte-identical** to the committed copies, so the local protoc-gen-es matches
CI's. `packages/sdk-typescript/src/protos/` is in `.prettierignore`, and the
committed file is byte-identical to raw protoc output.

### 2. `OrderAuthorization.amount_in` removed from consumers

- `packages/sdk-typescript/src/client.ts` — `PlaceOrderParams.authorization` doc
  now says order id only; the FCE guard's message drops `amountIn`; the FCE
  payload no longer forwards it.
- `packages/sdk-typescript/src/gasless-evm.ts` / `gasless-solana.ts` — the
  `OrderAuthorization` is now `{ orderId }`.
- `packages/sdk-typescript/src/fce/payloads.ts` — `amountIn` dropped from the
  direct-action `PlaceOrderRequest`.
- `ui/src/components/trade-panel/hooks/useTradeFormSubmit.ts` — the stale
  "reads only order_id + amount_in" comment corrected.

### 3. Market bids are reachable, so `quote_budget` is implemented

- `signing.ts` — `OrderSigningData.quoteBudget`, plumbed into
  `createOrderMessage` so the value is **inside the signed Order**. Omitted, it
  is wire-skipped: digests for the other three cells are unchanged.
- `client.ts` — `PlaceOrderParams.quoteBudget`, passed to the same builder that
  produces the signed bytes.
- `decimals.ts` — new `marketBidQuoteBudget()`: pair-decimal size x pair-decimal
  reference price → quote-token **native base units**, all in BigInt, mirroring
  the arborter's own `handlers::common::required_collateral` arithmetic (both
  steps floor, so the budget never exceeds the quote it was sized to spend).
- `useTradeFormSubmit.ts` — for `side === "buy" && orderType === "market"` only,
  sizes the budget at `bestAsk ?? lastTradePrice` (the same reference the
  existing balance check uses) and passes the identical string to both `signOrder`
  and `client.placeOrder`. Refuses with a clear message when there is no
  reference price, or when the budget floors to zero.
- New `market-bid-budget.test.ts` — 8 tests. Every scale case uses a market where
  pair decimals and quote-token decimals **differ** (18→6 and 6→18); equal
  decimals would pass with or without the conversion.

## Verification (actual output)

| Command                                       | Result                                              |
| --------------------------------------------- | --------------------------------------------------- |
| `bunx prettier --check .`                     | `All matched files use Prettier code style!`        |
| `bun run lint` (`eslint --fix`)               | exit 0, no output                                   |
| `bun run typecheck` (`tsc` + `tsc --noEmit`)  | exit 0, no diagnostics                              |
| `bun run build` (`tsc` + `next build`)        | `✓ Compiled successfully in 7.6s`, 3 routes, exit 0 |
| `bun test src` (in `packages/sdk-typescript`) | `81 pass, 0 fail, 145 expect() calls`               |
| `bun test src/market-bid-budget.test.ts`      | `8 pass, 0 fail`                                    |

`git status` was clean before the commit and is clean after.

**Pre-existing, unrelated:** a bare `bun test` in `packages/sdk-typescript` fails
1 test — `dist/signing.test.js`, an orphaned build artifact from 2026-04-15
asserting the old 64-byte signature slicing. `tsconfig.json` excludes
`src/**/*.test.ts` from the build, so `tsc` never overwrites it, and `dist/` is
gitignored, so nothing tracks it. `bun test src` is the honest signal. CI does
not run tests at all (`tests.yml` = install, build-sdk, fmt, lint, typecheck,
build), so this never surfaced. Worth a `rm -rf dist` or a `test` script scoped
to `src`.

## Market bids in the UI: reachable

`OrderTypeSelector` offers a Market tab; `TradePanel` hides `PriceInput` for it,
and `useTradeFormSubmit` sends `price: undefined`. Combined with the Buy side
that is a market BID today, so the minimum was implemented rather than skipped.

What the old code sent for that cell: `amountIn` was
`size * (orderType === "limit" ? price : 0) * 10^pairDecimals` — i.e. **0** for a
market buy, and in pair decimals where native units were required. Both bugs are
moot now.

### What a full market-bid UI would need

1. **Spend-amount input.** The user is choosing how much quote to spend, not a
   base quantity. Today's form takes size and derives the budget; a real one
   would take the budget and show an estimated fill quantity.
2. **Explicit slippage headroom.** The budget is sized at a reference price, so
   an upward move between signing and matching buys _less_ than `size` (it can
   never overspend — the budget is a hard cap). A headroom control (e.g. +N%)
   would make the tradeoff the user's.
3. **Unspent-tail messaging.** The arborter releases the unused remainder when
   the market order leaves the book; the fills panel should explain a partial
   fill rather than leave it looking like a failure.
4. **FCE transport support.** Needs `quoteBudget` in the ext-proxy adapter's
   `types.PlaceOrderRequest` first (see concerns).

## Concerns

1. **The `gasless-*.ts` `amountIn` premise was wrong.** The brief said that
   `amountIn` belonged to the on-chain lock struct and was unrelated to
   `OrderAuthorization`. It is not: both builders passed
   `amountIn: opts.amountIn.toString()` straight into
   `create(OrderAuthorizationSchema, ...)`, so they would not have compiled
   against the regenerated proto. Those two lines were removed. The **parameters**
   `amountIn` / `amountOut` were kept, because they are also inputs to
   `deriveOrderId` — that use is genuine and unrelated to the proto field; their
   docstrings now say which is which. No behaviour change to the derived id.
2. **Cross-repo deploy ordering.** This client no longer sends `amount_in`. An
   arborter built before protos@`09de11f` would read a market bid's commitment as
   absent. terminal-ui must ship with, or after, an arborter carrying the new
   proto (arborter main @ `6af9bb1` already does).
3. **`infra`'s FCE adapter still carries `amountIn`.**
   `infra/stacks/fcc/extension/pkg/types/types.go:82` and
   `internal/arborter/grpc.go:54` build `pb.OrderAuthorization{OrderId, AmountIn}`.
   That repo's proto sync has not landed either; when it does, `grpc.go` will not
   compile until `AmountIn` is dropped, and the adapter needs a `quoteBudget`
   field before market bids can work over FCE. Dropping the JSON key here is safe
   in the meantime — the adapter does not validate it, and an absent key leaves
   Go's zero value.
4. **The Rust `sdk` is also unsynced** (`aspens/proto/arborter.proto` still has
   `amount_in`), and its `gasless/mod.rs` explicitly refuses market orders for
   lack of an `amount_in` to commit. That refusal is now obsolete —
   `quote_budget` is exactly the missing figure — but it is out of scope here.
5. **Float→raw conversion is unchanged and still lossy.** The reference price
   goes through `Math.round(price * 10 ** pairDecimals)`, matching the existing
   `priceRaw` / `sizeRaw` lines directly above it. At `pairDecimals = 18` that is
   past double precision. Pre-existing across the whole hook; the new BigInt
   helper at least keeps the _scale_ conversion exact. Worth fixing form-wide by
   parsing the decimal strings directly.
6. **`orderInBook` left alone.** `client.ts` still derives
   `status: response.orderInBook ? "pending" : "filled"`, and
   `useTradeFormSubmit` keys its hidden-order tracking on `status === "pending"`.
   The arborter now reports the real value, so this logic is meaningful — not
   touched.
