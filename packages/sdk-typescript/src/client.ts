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
  OrderSchema,
  OrderToCancelSchema,
  type Order,
  type OrderToCancel,
  type SendOrderResponse,
  type Configuration,
} from "./grpc-transport.js";
import {
  toMarkets,
  toTokens,
  toEnhancedOrderbook,
  toEnhancedTrades,
  getPairDecimals,
} from "./adapters/index.js";
import { Side as ProtoSide, ExecutionType } from "./protos/arborter_pb.js";
import { fetchOnChainBalances, type WalletBinding } from "./balances.js";

export interface ExchangeClientConfig {
  grpcUrl: string;
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
  price?: string;
  size?: string;
  priceDecimal?: string;
  sizeDecimal?: string;
  signature: Uint8Array;
  baseAccountAddress: string;
  quoteAccountAddress: string;
  /**
   * Optional gasless authorization. When provided, the arborter will drive
   * the on-chain lock via the chain's gasless path (EVM: MidribV2.openFor
   * with the user's Permit2 + EIP-712 signature; Solana: MidribOpenFor
   * with Ed25519SigVerify precompile). On EVM chains the arborter-signed
   * legacy path has been deprecated — consumers on EVM must populate
   * this, built via `buildEvmGaslessAuthorization`.
   */
  gasless?: import("./protos/arborter_pb.js").GaslessAuthorization;
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
  constructor(
    private config: ExchangeClientConfig,
    private cache: CacheManager,
  ) {}

  async placeOrderDecimal(params: PlaceOrderParams): Promise<EnhancedOrder> {
    const pairDecimals = this.cache.getPairDecimals(params.marketId);

    // Convert decimal price/size to raw integer strings
    const priceDecimal = params.priceDecimal ?? params.price ?? "0";
    const sizeDecimal = params.sizeDecimal ?? params.size ?? "0";

    const priceRaw = this.decimalToRaw(priceDecimal, pairDecimals);
    const sizeRaw = this.decimalToRaw(sizeDecimal, pairDecimals);

    // Create the protobuf Order
    const order: Order = create(OrderSchema, {
      side: params.side === "buy" ? ProtoSide.BID : ProtoSide.ASK,
      quantity: sizeRaw,
      price: params.orderType === "limit" ? priceRaw : undefined,
      marketId: params.marketId,
      baseAccountAddress: params.baseAccountAddress,
      quoteAccountAddress: params.quoteAccountAddress,
      executionType: ExecutionType.UNSPECIFIED,
      matchingOrderIds: [],
    });

    // Send the order via gRPC, carrying the optional GaslessAuthorization
    // payload if present.
    const response = await arborterService.sendOrder(
      order,
      params.signature,
      params.gasless,
    );

    // Convert response to EnhancedOrder
    return this.responseToEnhancedOrder(response, params, pairDecimals);
  }

  async cancelOrder(params: CancelOrderParams): Promise<{ order_id: string }> {
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

  private decimalToRaw(decimal: string, decimals: number): string {
    const num = parseFloat(decimal);
    const raw = BigInt(Math.round(num * Math.pow(10, decimals)));
    return raw.toString();
  }

  private responseToEnhancedOrder(
    response: SendOrderResponse,
    params: PlaceOrderParams,
    pairDecimals: number,
  ): EnhancedOrder {
    const priceDecimal = params.priceDecimal ?? params.price ?? "0";
    const sizeDecimal = params.sizeDecimal ?? params.size ?? "0";
    const priceValue = parseFloat(priceDecimal);
    const sizeValue = parseFloat(sizeDecimal);

    return {
      id: response.orderId.toString(),
      user_address: params.userAddress,
      market_id: params.marketId,
      price: priceDecimal,
      size: sizeDecimal,
      side: params.side,
      order_type: params.orderType,
      status: response.orderInBook ? "pending" : "filled",
      filled_size: "0",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      priceValue,
      sizeValue,
      filledValue: 0,
      displayPrice: priceValue.toFixed(pairDecimals),
      displaySize: sizeValue.toFixed(pairDecimals),
      displayFilledSize: "0",
      priceDisplay: priceValue.toFixed(pairDecimals),
      sizeDisplay: sizeValue.toFixed(pairDecimals),
      filledDisplay: "0",
      trades: [],
    };
  }
}

export class ExchangeClient {
  public readonly cache: CacheManager;
  public readonly rest: RestClient;
  private config: ExchangeClientConfig;
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
    this.rest = new RestClient(this.config, this.cache);

    // Set the gRPC base URL
    setGrpcBaseUrl(this.config.grpcUrl);
    resetTransport();
  }

  // ============================================================================
  // INFO METHODS - Implemented with gRPC
  // ============================================================================

  /**
   * Get all available markets from gRPC backend
   * Falls back to stub data if backend is unavailable
   */
  async getMarkets(): Promise<Market[]> {
    try {
      const response = await configService.getConfig();
      if (response.config && response.config.markets.length > 0) {
        this.cache.setConfig(response.config);
        const markets = toMarkets(response.config);
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
      const response = await configService.getConfig();
      if (response.config && response.config.chains.length > 0) {
        this.cache.setConfig(response.config);
        const tokens = toTokens(response.config);
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
        const trades = await arborterService.getTrades(marketId, false, true);
        const enhancedTrades = toEnhancedTrades(trades, marketId, pairDecimals);

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

    // Set up polling interval (5 seconds)
    const interval = setInterval(poll, 5000);
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

    // Set up polling interval (3 seconds for orderbook)
    const interval = setInterval(poll, 3000);
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
    return this.rest.placeOrderDecimal(params);
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
