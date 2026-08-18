import type {
  Market,
  Token,
  EnhancedTrade,
  EnhancedOrder,
  EnhancedBalance,
  EnhancedOrderbookLevel,
  Candle,
  Side,
  OrderType,
} from "./types.js";

import { generateCandles, STUB_MARKETS, STUB_TOKENS } from "./stub-data.js";
import {
  setGrpcBaseUrl,
  resetTransport,
  configService,
  arborterService,
  create,
  OrderToCancelSchema,
  type Order,
  type OrderToCancel,
  type SendOrderResponse,
  type Configuration,
  type AttestationReport,
} from "./grpc-transport.js";
import {
  toMarkets,
  toTokens,
  toEnhancedOrderbook,
  toEnhancedTrades,
  getPairDecimals,
} from "./adapters/index.js";
import {
  Side as ProtoSide,
  WithdrawResponseSchema,
  type WithdrawResponse,
} from "./protos/arborter_pb.js";
import { createOrderMessage } from "./signing.js";
import { fetchOnChainBalances, type WalletBinding } from "./balances.js";
import { toDisplayValue, toDisplayValueCapped } from "./decimals.js";
import { bytesToHex } from "viem";
import {
  FceClient,
  FCE_ORDER_NONCE,
  hexBytesToBytes,
  type FceClientOptions,
  decodeConfigEnvelope,
  fceBookToEnhanced,
  fceOpenOrdersToEnhanced,
  fceTradesToEnhanced,
} from "./fce/index.js";

export interface ExchangeClientConfig {
  grpcUrl: string;
  /**
   * Action transport. `"grpc"` (default) talks to arborter through Envoy.
   * `"fce"` routes write actions (place / cancel / withdraw) through the Flare
   * Confidential Extension ext-proxy instead — config discovery, reads, and
   * polling streams stay on gRPC either way. Requires `fce` to be set.
   */
  transport?: "grpc" | "fce";
  /** ext-proxy connection, required when `transport === "fce"`. */
  fce?: FceClientOptions;
}

/** Build the FCE client iff the config selects the fce transport. */
function buildFceClient(config: ExchangeClientConfig): FceClient | undefined {
  if (config.transport !== "fce") return undefined;
  if (!config.fce) {
    throw new Error('ExchangeClientConfig.transport="fce" requires config.fce');
  }
  return new FceClient(config.fce);
}

export interface CandlesParams {
  marketId: string;
  interval: string;
  from: number;
  to: number;
  countBack?: number;
}

export interface PlaceOrderParams {
  userAddress: string;
  marketId: string;
  side: Side;
  orderType: OrderType;
  /**
   * Base quantity as a pair-decimal-scaled integer string — the SAME string
   * that went into `OrderSigningData.quantity` when `signature` was produced.
   *
   * The SDK takes the raw value and never re-derives it, deliberately. The
   * wire `Order` is what the arborter re-encodes to verify the envelope
   * signature, so a second conversion here — from a decimal string, by
   * whatever arithmetic — is a second chance to disagree with the bytes the
   * wallet signed, and the failure it produces is a recovered address that
   * isn't the sender's. Convert once at the edge with
   * {@link import("./decimals.js").decimalToRaw} and pass that one value to
   * both the signing data and this call.
   */
  sizeRaw: string;
  /**
   * Limit price, pair-decimal-scaled, matching `OrderSigningData.price`.
   * `undefined` for a market order — the same absence the signed message
   * carries, since proto3 wire-skips an unset optional.
   */
  priceRaw?: string;
  /**
   * The scale `sizeRaw` / `priceRaw` are expressed in — the market's
   * `pair_decimals`. Stated by the caller rather than looked up here so the
   * scale the amounts were built at is the scale they are read back at; a
   * cache miss would otherwise render the order at the 8-decimal default.
   */
  pairDecimals: number;
  signature: Uint8Array;
  baseAccountAddress: string;
  quoteAccountAddress: string;
  /**
   * `Order.nonce` — and it must be the SAME value passed to
   * `OrderSigningData.nonce` when `signature` was produced. The wire order is
   * rebuilt here from these params, so a nonce that differs from the signed
   * one changes the bytes the arborter verifies against and the order is
   * refused for a bad signature.
   *
   * On the FCE transport it must be `FCE_ORDER_NONCE` (zero) — see
   * `placeOrderFce`.
   */
  nonce: bigint;
  /**
   * The caller's own copy of the canonical order id, from
   * `buildOrderCommitment`. Required on the FCE transport, whose adapter JSON
   * still declares the key; ignored on gRPC, where the arborter derives the id
   * itself and `OrderAuthorization` no longer exists to carry one.
   */
  orderId?: string;
  /**
   * A market BID's spending budget, in the QUOTE token's native base units —
   * see `OrderSigningData.quoteBudget`, whose value this must equal, since the
   * envelope signature covers it. Required for a market bid and rejected by
   * the arborter on every other cell.
   */
  quoteBudget?: string;
  /**
   * Post-only: when true, arborter rejects the order with
   * FAILED_PRECONDITION (no on-chain lock, no gas spent) if it would
   * cross any opposing confirmed order at submission. Guarantees
   * maker-side execution. Limit orders only — set false for market
   * orders; the SDK does not validate this, but arborter will reject
   * `post_only=true` paired with an absent price.
   *
   * Defaults to false. Proto3 wire-skips the default, so existing
   * signed-envelope digests stay byte-identical for legacy callers.
   */
  postOnly?: boolean;
  /**
   * Hidden ("invisible") order — see `OrderSigningData.hidden`. Valid
   * for both limit and market orders (a hidden market order is an
   * anonymous taker). Defaults to false (wire-skipped).
   */
  hidden?: boolean;
}

export interface CancelOrderParams {
  userAddress: string;
  orderId: string;
  marketId: string;
  side: Side;
  tokenAddress: string;
  signature: Uint8Array;
}

export interface CancelAllOrdersParams {
  userAddress: string;
  marketId?: string;
  signature: Uint8Array;
}

type UnsubscribeFn = () => void;

class CacheManager {
  private markets: Map<string, Market> = new Map();
  private tokens: Map<string, Token> = new Map();
  private config: Configuration | null = null;

  setMarkets(markets: Market[]): void {
    this.markets.clear();
    for (const market of markets) {
      this.markets.set(market.id, market);
    }
  }

  setTokens(tokens: Token[]): void {
    this.tokens.clear();
    for (const token of tokens) {
      this.tokens.set(token.ticker, token);
    }
  }

  setConfig(config: Configuration): void {
    this.config = config;
  }

  getConfig(): Configuration | null {
    return this.config;
  }

  getAllMarkets(): Market[] {
    return Array.from(this.markets.values());
  }

  getMarket(id: string): Market | undefined {
    return this.markets.get(id);
  }

  getToken(ticker: string): Token | undefined {
    return this.tokens.get(ticker);
  }

  getAllTokens(): Token[] {
    return Array.from(this.tokens.values());
  }

  getPairDecimals(marketId: string): number {
    const market = this.markets.get(marketId);
    return market?.pairDecimals ?? 8;
  }
}

class RestClient {
  // No cache dependency: the only thing this client used to read from it was
  // the market's pair decimals, to convert a decimal amount into the raw one
  // the wire carries. That conversion is gone — the caller supplies the raw
  // values it signed — and with it the chance of a cache miss silently
  // rescaling an order to the 8-decimal default.
  constructor(
    private config: ExchangeClientConfig,
    private fce?: FceClient,
  ) {}

  /**
   * Send an already-signed order. The raw amounts arrive from the caller and
   * go on the wire untouched — see `PlaceOrderParams.sizeRaw` for why this
   * method derives nothing.
   */
  async placeOrder(params: PlaceOrderParams): Promise<EnhancedOrder> {
    // A market order has no price, and the signed message says so by leaving
    // the optional field unset. A price supplied alongside `orderType:
    // "market"` means the caller built the two messages from different ideas
    // of the order; that reaches the arborter as a signature failure, so stop
    // it here where the reason can be stated.
    if (params.orderType === "market" && params.priceRaw !== undefined) {
      throw new Error(
        "placeOrder: a market order must not carry priceRaw (the signed Order leaves the price unset)",
      );
    }

    if (this.fce) {
      return this.placeOrderFce(params);
    }

    // Build the wire Order with the SAME builder the signing path uses
    // (`createOrderMessage`) — the envelope signature is over these
    // bytes as arborter re-encodes them, so constructing the proto in
    // two places invites a silent digest mismatch. One build site makes
    // that class of bug unrepresentable.
    const order: Order = createOrderMessage({
      side: params.side,
      quantity: params.sizeRaw,
      price: params.priceRaw,
      marketId: params.marketId,
      baseAccountAddress: params.baseAccountAddress,
      quoteAccountAddress: params.quoteAccountAddress,
      postOnly: params.postOnly ?? false,
      hidden: params.hidden ?? false,
      quoteBudget: params.quoteBudget,
      nonce: params.nonce,
    });

    const response = await arborterService.sendOrder(order, params.signature);

    // Convert response to EnhancedOrder
    return this.responseToEnhancedOrder(response, params);
  }

  /**
   * FCE variant of `placeOrder`. The ext-proxy adapter *reconstructs*
   * the arborter Order from these scalar fields with `hidden=false` and empty
   * `matching_order_ids` (proto3 defaults), then verifies `params.signature`
   * against that reconstruction. So the signature the caller passed must have
   * been produced over a `hidden=false` order — a hidden order can't round-trip
   * this channel byte-identically, so reject it rather than fail silently
   * downstream. `orderId` is the id the adapter's JSON still declares and is
   * mandatory here.
   *
   * `nonce` is the same shape of problem: the direct-action JSON has no field
   * for it and the adapter rebuilds the `Order` without one, so only
   * `FCE_ORDER_NONCE` (zero, wire-skipped) round-trips byte-identically. A
   * non-zero nonce would be signed here and absent there, the arborter would
   * recover a different address, and the order would be refused for a bad
   * signature with nothing said about a nonce — so refuse it here, with the
   * reason.
   *
   * A market BID is likewise unsupported on this channel: the direct-action
   * payload has no `quoteBudget` field (the ext-proxy adapter's
   * `types.PlaceOrderRequest` predates it), so the budget would be dropped in
   * transit and the arborter would refuse the order as unbounded. Fail here
   * with the reason instead.
   */
  private async placeOrderFce(
    params: PlaceOrderParams,
  ): Promise<EnhancedOrder> {
    if (params.hidden) {
      throw new Error(
        "FCE transport does not support hidden orders (the adapter reconstructs hidden=false, breaking signature parity)",
      );
    }
    if (!params.orderId) {
      throw new Error("FCE placeOrder requires params.orderId");
    }
    if (params.nonce !== FCE_ORDER_NONCE) {
      throw new Error(
        `FCE transport can only carry Order.nonce = ${FCE_ORDER_NONCE} (got ${params.nonce}): the direct-action payload has no nonce field, so the adapter rebuilds the order without one and signature verification fails`,
      );
    }
    if (params.quoteBudget !== undefined) {
      throw new Error(
        "FCE transport does not support market bids (the direct-action payload carries no quote budget, so the arborter would refuse the order as unbounded)",
      );
    }

    const out = await this.fce!.placeOrder({
      side: params.side === "buy" ? "BID" : "ASK",
      quantity: params.sizeRaw,
      price: params.priceRaw,
      marketId: params.marketId,
      baseAccountAddress: params.baseAccountAddress,
      quoteAccountAddress: params.quoteAccountAddress,
      postOnly: params.postOnly ? true : undefined,
      signatureHash: bytesToHex(params.signature),
      orderId: params.orderId,
    });

    if (out.status !== 1 || !out.data) {
      throw new Error(`FCE placeOrder failed: ${out.log}`);
    }

    // Shim the direct-action response into the gRPC response shape the
    // enhancer expects (it reads only orderId + orderInBook).
    const shim = {
      orderId: BigInt(out.data.orderId),
      orderInBook: out.data.orderInBook,
    } as SendOrderResponse;
    return this.responseToEnhancedOrder(shim, params);
  }

  async cancelOrder(params: CancelOrderParams): Promise<{ order_id: string }> {
    if (this.fce) {
      const out = await this.fce.cancelOrder({
        marketId: params.marketId,
        side: params.side === "buy" ? "BID" : "ASK",
        tokenAddress: params.tokenAddress,
        // Pass the id through as a STRING. Number() rounds anything above
        // 2^53 — this line is what sent 173852891691592600 for order
        // 173852891691592598 and made every cancel fail with NotFound.
        orderId: params.orderId,
        signatureHash: bytesToHex(params.signature),
      });
      if (out.status !== 1) {
        throw new Error(`FCE cancelOrder failed: ${out.log}`);
      }
      return { order_id: params.orderId };
    }

    const orderToCancel: OrderToCancel = create(OrderToCancelSchema, {
      marketId: params.marketId,
      side: params.side === "buy" ? ProtoSide.BID : ProtoSide.ASK,
      tokenAddress: params.tokenAddress,
      orderId: BigInt(params.orderId),
    });

    const response = await arborterService.cancelOrder(
      orderToCancel,
      params.signature,
    );

    return {
      order_id: params.orderId,
    };
  }

  /**
   * Render the placed order for the UI. Everything human-readable here is
   * derived FROM the raw values that went on the wire, so the record shown to
   * the user is the order that was actually sent — a decimal string carried
   * alongside the raw one would be a second version of the same number, free
   * to disagree with it.
   */
  private responseToEnhancedOrder(
    response: SendOrderResponse,
    params: PlaceOrderParams,
  ): EnhancedOrder {
    const priceDecimal = toDisplayValue(
      params.priceRaw ?? "0",
      params.pairDecimals,
    );
    const sizeDecimal = toDisplayValue(params.sizeRaw, params.pairDecimals);
    const priceValue = parseFloat(priceDecimal);
    const sizeValue = parseFloat(sizeDecimal);

    const priceDisplay = toDisplayValueCapped(
      params.priceRaw ?? "0",
      params.pairDecimals,
    );
    const sizeDisplay = toDisplayValueCapped(
      params.sizeRaw,
      params.pairDecimals,
    );

    return {
      id: response.orderId.toString(),
      user_address: params.userAddress,
      market_id: params.marketId,
      price: priceDecimal,
      size: sizeDecimal,
      side: params.side,
      order_type: params.orderType,
      status: response.orderInBook ? "pending" : "filled",
      hidden: params.hidden ?? false,
      filled_size: "0",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      priceValue,
      sizeValue,
      filledValue: 0,
      displayPrice: priceDisplay,
      displaySize: sizeDisplay,
      displayFilledSize: "0",
      priceDisplay,
      sizeDisplay,
      filledDisplay: "0",
      trades: [],
    };
  }
}

export class ExchangeClient {
  public readonly cache: CacheManager;
  public readonly rest: RestClient;
  private config: ExchangeClientConfig;
  private fce?: FceClient;
  private pollingIntervals: Map<string, ReturnType<typeof setInterval>> =
    new Map();
  private isConnected = false;

  constructor(configOrUrl: ExchangeClientConfig | string) {
    if (typeof configOrUrl === "string") {
      this.config = { grpcUrl: configOrUrl };
    } else {
      this.config = configOrUrl;
    }
    this.cache = new CacheManager();
    this.fce = buildFceClient(this.config);
    this.rest = new RestClient(this.config, this.fce);

    // Set the gRPC base URL. Config discovery routes over FCE when an ext-proxy
    // is configured (see `fetchConfiguration`); reads/polling still use gRPC, so
    // this is set regardless and is simply unused on the FCE-only path.
    setGrpcBaseUrl(this.config.grpcUrl);
    resetTransport();
  }

  // ============================================================================
  // INFO METHODS - Implemented with gRPC
  // ============================================================================

  /**
   * Fetch the arborter configuration, over FCE when an ext-proxy is configured
   * and over gRPC otherwise.
   *
   * Config discovery is what makes an FCE-only client possible: building a
   * signed order needs the market's pair decimals and the base/quote chains'
   * curves, and before `GET_CONFIG` existed those came only from arborter gRPC
   * — so a client could place writes through the proxy but could not learn what
   * to write. Mirrors `AspensClient::fetch_config` in the Rust SDK.
   *
   * Returns `null` on failure so the existing stub-data fallbacks are unchanged.
   */
  private async fetchConfiguration(): Promise<Configuration | null> {
    if (this.fce) {
      const cached = this.cache.getConfig();
      // Each /direct action costs a submit plus a poll cycle, and getMarkets +
      // getTokens are normally called back to back. Reuse the cached config
      // rather than paying that twice on startup.
      if (cached) return cached;

      const out = await this.fce.getConfig();
      if (out.status !== 1 || !out.data) {
        throw new Error(
          `GET_CONFIG failed over FCE: ${out.log || "no data returned"}`,
        );
      }
      return decodeConfigEnvelope(out.data);
    }
    const response = await configService.getConfig();
    return response.config ?? null;
  }

  /**
   * Get all available markets from the arborter (FCE or gRPC).
   * Falls back to stub data if the backend is unavailable.
   */
  async getMarkets(): Promise<Market[]> {
    try {
      const config = await this.fetchConfiguration();
      if (config && config.markets.length > 0) {
        this.cache.setConfig(config);
        const markets = toMarkets(config);
        this.cache.setMarkets(markets);
        return markets;
      }
    } catch (error) {
      console.warn(
        "[SDK] Failed to get markets from backend, using stub data:",
        error,
      );
    }

    // Fall back to stub data
    console.log("[SDK] Using stub market data");
    this.cache.setMarkets(STUB_MARKETS);
    return STUB_MARKETS;
  }

  /**
   * Get all available tokens from gRPC backend
   * Falls back to stub data if backend is unavailable
   */
  async getTokens(): Promise<Token[]> {
    try {
      const config = await this.fetchConfiguration();
      if (config && config.chains.length > 0) {
        this.cache.setConfig(config);
        const tokens = toTokens(config);
        this.cache.setTokens(tokens);
        return tokens;
      }
    } catch (error) {
      console.warn(
        "[SDK] Failed to get tokens from backend, using stub data:",
        error,
      );
    }

    // Fall back to stub data
    console.log("[SDK] Using stub token data");
    this.cache.setTokens(STUB_TOKENS);
    return STUB_TOKENS;
  }

  /**
   * Fetch the TEE attestation report from the arborter's signer.
   *
   * Returns null if the backend doesn't expose attestation or the call
   * fails — callers (notably the attestation modal) want to render an
   * error state rather than crash on a missing report.
   */
  async getAttestation(
    reportData?: Uint8Array,
  ): Promise<AttestationReport | null> {
    try {
      const response = await configService.getAttestation(reportData);
      return response.report ?? null;
    } catch (error) {
      console.warn("[SDK] Failed to fetch attestation:", error);
      return null;
    }
  }

  /**
   * Request a TEE-signed withdrawal voucher (Track A §8) for
   * `MidribV3.withdraw(voucher, signature)`. The caller signs the canonical
   * request bytes `"network|token|account|amount"` with the withdrawer's
   * wallet (EIP-191 personal-sign on EVM, Ed25519 on Solana) and passes the
   * signature here; errors from the arborter (e.g. insufficient withdrawable
   * balance) propagate to the caller.
   */
  async requestWithdrawVoucher(params: {
    network: string;
    token: string;
    account: string;
    /** Amount in token base units, as a decimal string. */
    amount: string;
    signature: Uint8Array;
  }): Promise<WithdrawResponse> {
    if (this.fce) {
      const out = await this.fce.withdraw({
        network: params.network,
        token: params.token,
        account: params.account,
        amount: params.amount,
        signature: bytesToHex(params.signature),
      });
      if (out.status !== 1 || !out.data) {
        throw new Error(`FCE withdraw failed: ${out.log}`);
      }
      const v = out.data;
      // Re-shape the direct-action voucher into the gRPC WithdrawResponse the
      // MidribV3.withdraw(...) caller expects (nonce/expiry widen to bigint;
      // the TEE signature decodes from 0x-hex back to raw bytes).
      return create(WithdrawResponseSchema, {
        account: v.account,
        token: v.token,
        amount: v.amount,
        nonce: BigInt(v.nonce),
        expiry: BigInt(v.expiry),
        signature: hexBytesToBytes(v.signature),
      });
    }
    return arborterService.requestWithdrawVoucher(params);
  }

  /**
   * Get OHLCV candle data for charting
   * Note: Stub implementation - Arborter doesn't have a candle endpoint
   */
  async getCandles(params: CandlesParams): Promise<Candle[]> {
    const { marketId, interval, from, to, countBack } = params;
    // Stub candle generation
    return generateCandles(marketId, interval, from, to, countBack);
  }

  // ============================================================================
  // USER METHODS - Implemented with gRPC
  // ============================================================================

  /**
   * Fetch the user's balances by doing per-chain on-chain queries
   * (ERC-20 / MidribV2 on EVM, SPL token + UserBalance PDA on Solana)
   * for every chain in the cached arborter config whose architecture
   * matches a connected wallet.
   *
   * The arborter has no direct balance endpoint — it only sees in-flight
   * orders. Real balances live on-chain.
   *
   * Backward-compat: callers that pass a plain address string get EVM-only
   * lookups. Prefer passing the full `WalletBinding[]` so Solana balances
   * are included.
   */
  async getBalances(
    userOrWallets: string | WalletBinding[],
  ): Promise<EnhancedBalance[]> {
    const config = this.cache.getConfig();
    if (!config) return [];
    const wallets: WalletBinding[] =
      typeof userOrWallets === "string"
        ? [{ address: userOrWallets, ecosystem: "evm" }]
        : userOrWallets;
    if (wallets.length === 0) return [];
    try {
      return await fetchOnChainBalances({ wallets, config });
    } catch (error) {
      console.warn("[SDK] getBalances on-chain query failed:", error);
      return [];
    }
  }

  async getOrders(
    userAddress: string,
    marketId?: string,
  ): Promise<EnhancedOrder[]> {
    // Get user's orders from orderbook filtered by trader
    if (!marketId) return [];

    try {
      const pairDecimals = this.cache.getPairDecimals(marketId);
      if (this.fce) {
        const out = await this.fce.getMyState({
          marketId,
          trader: userAddress,
        });
        if (out.status !== 1 || !out.data) {
          throw new Error(`GET_MY_STATE failed: ${out.log || "no data"}`);
        }
        return fceOpenOrdersToEnhanced(
          out.data,
          marketId,
          userAddress,
          pairDecimals,
        );
      }
      const entries = await arborterService.getOrderbook(
        marketId,
        false,
        true, // historicalOpenOrders
        userAddress, // filterByTrader
      );

      // Convert orderbook entries to EnhancedOrder format
      return entries.map((entry) => ({
        id: entry.orderId.toString(),
        user_address: entry.makerBaseAddress || entry.makerQuoteAddress,
        market_id: marketId,
        price: entry.price,
        size: entry.quantity,
        side: entry.side === 1 ? ("buy" as Side) : ("sell" as Side),
        order_type: "limit" as OrderType,
        status: "pending" as const,
        filled_size: "0",
        created_at: new Date(Number(entry.timestamp)).toISOString(),
        updated_at: new Date(Number(entry.timestamp)).toISOString(),
        priceValue: parseFloat(entry.price) / Math.pow(10, pairDecimals),
        sizeValue: parseFloat(entry.quantity) / Math.pow(10, pairDecimals),
        filledValue: 0,
        displayPrice: (
          parseFloat(entry.price) / Math.pow(10, pairDecimals)
        ).toFixed(pairDecimals),
        displaySize: (
          parseFloat(entry.quantity) / Math.pow(10, pairDecimals)
        ).toFixed(pairDecimals),
        displayFilledSize: "0",
        priceDisplay: (
          parseFloat(entry.price) / Math.pow(10, pairDecimals)
        ).toFixed(pairDecimals),
        sizeDisplay: (
          parseFloat(entry.quantity) / Math.pow(10, pairDecimals)
        ).toFixed(pairDecimals),
        filledDisplay: "0",
      }));
    } catch (error) {
      console.error("[SDK] Failed to get orders:", error);
      return [];
    }
  }

  async getTrades(
    userAddress: string,
    marketId?: string,
  ): Promise<EnhancedTrade[]> {
    if (!marketId) return [];

    try {
      const pairDecimals = this.cache.getPairDecimals(marketId);
      if (this.fce) {
        const out = await this.fce.exportHistory({
          marketId,
          trader: userAddress,
        });
        if (out.status !== 1 || !out.data) {
          throw new Error(`EXPORT_HISTORY failed: ${out.log || "no data"}`);
        }
        return fceTradesToEnhanced(out.data, marketId, pairDecimals);
      }
      const trades = await arborterService.getTrades(
        marketId,
        false,
        true, // historicalClosedTrades
        userAddress, // filterByTrader
      );

      return toEnhancedTrades(trades, marketId, pairDecimals);
    } catch (error) {
      console.error("[SDK] Failed to get trades:", error);
      return [];
    }
  }

  // ============================================================================
  // STREAMING SUBSCRIPTIONS - Implemented with gRPC polling
  // ============================================================================

  onTrades(
    marketId: string,
    callback: (trade: EnhancedTrade) => void,
  ): UnsubscribeFn {
    const key = `trades:${marketId}`;
    let lastTradeTimestamp = 0n;

    const poll = async () => {
      try {
        const pairDecimals = this.cache.getPairDecimals(marketId);
        let enhancedTrades: EnhancedTrade[];
        if (this.fce) {
          const out = await this.fce.exportHistory({ marketId, trader: "" });
          enhancedTrades =
            out.status === 1 && out.data
              ? fceTradesToEnhanced(out.data, marketId, pairDecimals)
              : [];
        } else {
          const trades = await arborterService.getTrades(marketId, false, true);
          enhancedTrades = toEnhancedTrades(trades, marketId, pairDecimals);
        }

        for (const trade of enhancedTrades) {
          const tradeTimestamp = BigInt(new Date(trade.timestamp).getTime());
          if (tradeTimestamp > lastTradeTimestamp) {
            lastTradeTimestamp = tradeTimestamp;
            callback(trade);
          }
        }
      } catch (error) {
        console.error("[SDK] Error polling trades:", error);
      }
    };

    // Initial poll
    poll();

    // Every FCE read is a submit plus a poll cycle, so it cannot sustain the
    // gRPC cadence — a 5s trades poll against that would queue behind itself.
    const interval = setInterval(poll, this.fce ? 10000 : 5000);
    this.pollingIntervals.set(key, interval);

    return () => {
      const interval = this.pollingIntervals.get(key);
      if (interval) {
        clearInterval(interval);
        this.pollingIntervals.delete(key);
      }
    };
  }

  onOrderbook(
    marketId: string,
    callback: (data: {
      bids: EnhancedOrderbookLevel[];
      asks: EnhancedOrderbookLevel[];
    }) => void,
  ): UnsubscribeFn {
    const key = `orderbook:${marketId}`;

    const poll = async () => {
      try {
        const pairDecimals = this.cache.getPairDecimals(marketId);
        if (this.fce) {
          const out = await this.fce.getBookState({ marketId, depth: 0 });
          if (out.status !== 1 || !out.data) {
            throw new Error(`GET_BOOK_STATE failed: ${out.log || "no data"}`);
          }
          callback(fceBookToEnhanced(out.data, pairDecimals));
          return;
        }
        const entries = await arborterService.getOrderbook(
          marketId,
          false,
          true,
        );
        const { bids, asks } = toEnhancedOrderbook(entries, pairDecimals);
        callback({ bids, asks });
      } catch (error) {
        console.error("[SDK] Error polling orderbook:", error);
        // Emit empty orderbook on error
        callback({ bids: [], asks: [] });
      }
    };

    // Initial poll
    poll();

    // As above: 3s is far inside one FCE round trip.
    const interval = setInterval(poll, this.fce ? 6000 : 3000);
    this.pollingIntervals.set(key, interval);

    return () => {
      const interval = this.pollingIntervals.get(key);
      if (interval) {
        clearInterval(interval);
        this.pollingIntervals.delete(key);
      }
    };
  }

  onUserOrders(
    userAddress: string,
    callback: (order: {
      order_id: string;
      status: string;
      filled_size: string;
    }) => void,
  ): UnsubscribeFn {
    // User order updates would require subscribing to orderbook changes
    // For now, return no-op
    return () => {};
  }

  onUserBalances(
    userAddress: string,
    callback: (balance: EnhancedBalance) => void,
  ): UnsubscribeFn {
    // Balance updates would require on-chain event subscription
    // For now, return no-op
    return () => {};
  }

  onUserFills(
    userAddress: string,
    callback: (trade: EnhancedTrade) => void,
  ): UnsubscribeFn {
    // User fills would require subscribing to trades filtered by user
    // For now, return no-op
    return () => {};
  }

  // ============================================================================
  // TRADING METHODS - Implemented with gRPC
  // ============================================================================

  async placeOrder(params: PlaceOrderParams): Promise<EnhancedOrder> {
    return this.rest.placeOrder(params);
  }

  async cancelOrder(params: CancelOrderParams): Promise<{ order_id: string }> {
    return this.rest.cancelOrder(params);
  }

  async cancelAllOrders(
    params: CancelAllOrdersParams,
  ): Promise<{ cancelled_order_ids: string[]; count: number }> {
    // Arborter doesn't have a cancel-all endpoint
    // Would need to fetch all orders and cancel individually
    console.warn("[SDK] cancelAllOrders not implemented for gRPC backend");
    return { cancelled_order_ids: [], count: 0 };
  }

  // ============================================================================
  // CONNECTION MANAGEMENT
  // ============================================================================

  connect(): void {
    this.isConnected = true;
    console.log("[SDK] Connected to gRPC backend");
  }

  disconnect(): void {
    this.isConnected = false;

    // Clean up all polling intervals
    for (const [key, interval] of this.pollingIntervals) {
      clearInterval(interval);
    }
    this.pollingIntervals.clear();

    console.log("[SDK] Disconnected from gRPC backend");
  }
}
