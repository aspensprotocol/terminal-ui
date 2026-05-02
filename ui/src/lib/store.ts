/**
 * Global state management with Zustand
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type {
  Market,
  Token,
  Orderbook,
  Trade,
  OrderbookLevel,
  Balance,
  Order,
  OrderStatus,
} from "./types/exchange";
import type { ConnectedWallet } from "./wallet/types";
import type { Configuration } from "@aspens/terminal-sdk";

/** Shape of a locally-tracked cancelled order — see `cancelledOrders`. */
export interface CancelledOrderEntry {
  /** Arborter order id (as a string for JSON-safe localStorage). */
  orderId: string;
  marketId: string;
  side: "buy" | "sell";
  /** Display price at submission time, as a string (preserves precision). */
  priceDisplay: string;
  /** Display size at submission time. */
  sizeDisplay: string;
  /** Wall-clock timestamp (ms) when the cancel landed. */
  cancelledAt: number;
  /** User who cancelled (we key persistence per address). */
  userAddress: string;
}

const CANCELLED_ORDERS_STORAGE_KEY = "aspens.cancelledOrders.v1";

function loadCancelledOrders(): CancelledOrderEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CANCELLED_ORDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCancelledOrders(entries: CancelledOrderEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    // Cap at 500 entries — way past what a single user produces, but
    // a ceiling in case something wedges the log in a loop.
    const capped = entries.slice(-500);
    window.localStorage.setItem(
      CANCELLED_ORDERS_STORAGE_KEY,
      JSON.stringify(capped),
    );
  } catch {
    // quota exhausted / private browsing; a missed persist is survivable
  }
}

// ============================================================================
// State Interface
// ============================================================================

interface ExchangeState {
  // Market data (Records for O(1) lookup/insert/update)
  markets: Record<string, Market>;
  tokens: Record<string, Token>;
  /**
   * Mirror of the gRPC `ConfigService.GetConfig` response. Holds
   * everything the SDK's internal `client.cache.config` does, exposed
   * via Zustand so React components can subscribe to changes (the SDK
   * cache is mutable internal state and isn't observable from React).
   *
   * Use this when a component needs richer per-chain metadata than
   * `markets`/`tokens` provide — e.g. `chain.architecture`,
   * `chain.tokens` keyed per chain, `chain.factoryAddress`. For raw
   * trading flows, `markets`/`tokens` are still the right hooks.
   */
  config: Configuration | null;
  latestPrices: Record<string, number>; // Latest trade price per token (e.g., BTC -> 95000)

  // UI Data
  selectedMarketId: string | null;
  orderbook: Orderbook | null;
  recentTrades: Trade[]; // Keep as array for chronological ordering
  selectedPrice: number | null;

  // User Data
  userAddress: string | null;
  isAuthenticated: boolean;
  userBalances: Record<string, Balance>; // Keyed by token_ticker
  /**
   * Per-chain, per-token balance slices. Populated alongside
   * `userBalances` — the panel shows the aggregated view while the
   * Transfer / deposit UI needs the per-chain breakdown.
   */
  chainBalanceSlices: import("@aspens/terminal-sdk").ChainBalanceSlice[];
  userOrders: Record<string, Order>; // Keyed by order id
  userTrades: Trade[]; // Keep as array for chronological ordering
  /**
   * Client-side log of orders the user has cancelled. The arborter
   * drops cancelled orders from the orderbook once the cancel lands,
   * so they stop being queryable. We track them locally (with
   * localStorage persistence per user address) so the Order History
   * tab can still show them.
   */
  cancelledOrders: CancelledOrderEntry[];

  // Multi-wallet state
  connectedWallets: Record<string, ConnectedWallet>; // Keyed by wallet id
  activeWalletId: string | null;

  // Actions - Market Data
  setMarkets: (markets: Market[]) => void;
  setTokens: (tokens: Token[]) => void;
  /**
   * Replace the cached `Configuration` mirror. Pass `null` to clear
   * (e.g. on stack URL change). See `config` field for rationale.
   */
  setConfig: (config: Configuration | null) => void;

  // Actions - UI Data
  selectMarket: (marketId: string) => void;
  setSelectedPrice: (price: number | null) => void;
  updateOrderbook: (
    marketId: string,
    bids: OrderbookLevel[],
    asks: OrderbookLevel[],
  ) => void;
  addTrade: (trade: Trade) => void;

  // Actions - User Data
  setUser: (address: string) => void;
  clearUser: () => void;

  // Actions - Multi-wallet
  connectWallet: (wallet: ConnectedWallet) => void;
  disconnectWallet: (walletId: string) => void;
  setActiveWallet: (walletId: string) => void;
  setBalances: (balances: Balance[]) => void;
  setChainBalanceSlices: (
    slices: import("@aspens/terminal-sdk").ChainBalanceSlice[],
  ) => void;
  /** Append a cancelled order to the persisted history log. */
  recordCancelledOrder: (entry: CancelledOrderEntry) => void;
  updateBalance: (
    tokenTicker: string,
    available: string,
    locked: string,
  ) => void;
  setOrders: (orders: Order[]) => void;
  updateOrder: (
    orderId: string,
    status: OrderStatus,
    filledSize: string,
  ) => void;
  setUserTrades: (trades: Trade[]) => void;
  addUserTrade: (trade: Trade) => void;

  // Utilities
  reset: () => void;
}

// ============================================================================
// Initial State
// ============================================================================

const initialState = {
  // Market Data
  markets: {} as Record<string, Market>,
  tokens: {} as Record<string, Token>,
  config: null as Configuration | null,
  latestPrices: { USDC: 1.0 } as Record<string, number>,

  // UI Data
  selectedMarketId: null,
  orderbook: null,
  recentTrades: [],
  selectedPrice: null,

  // User Data
  userAddress: null,
  isAuthenticated: false,
  userBalances: {} as Record<string, Balance>,
  chainBalanceSlices: [] as import("@aspens/terminal-sdk").ChainBalanceSlice[],
  userOrders: {} as Record<string, Order>,
  userTrades: [],
  cancelledOrders: loadCancelledOrders(),

  // Multi-wallet
  connectedWallets: {} as Record<string, ConnectedWallet>,
  activeWalletId: null,
};

// ============================================================================
// Store
// ============================================================================

export const useExchangeStore = create<ExchangeState>()(
  devtools(
    immer((set) => ({
      ...initialState,

      // ========================================================================
      // Market Data Actions
      // ========================================================================

      setMarkets: (markets) =>
        set((state) => {
          // Convert array to Record keyed by id
          state.markets = markets.reduce(
            (acc, market) => {
              acc[market.id] = market;
              return acc;
            },
            {} as Record<string, Market>,
          );
        }),

      setTokens: (tokens) =>
        set((state) => {
          // Convert array to Record keyed by ticker
          state.tokens = tokens.reduce(
            (acc, token) => {
              acc[token.ticker] = token;
              return acc;
            },
            {} as Record<string, Token>,
          );
        }),

      setConfig: (config) =>
        set((state) => {
          state.config = config;
        }),

      // ========================================================================
      // UI Data Actions
      // ========================================================================

      selectMarket: (marketId) =>
        set((state) => {
          state.selectedMarketId = marketId;
          state.orderbook = null;
          state.recentTrades = [];
        }),

      setSelectedPrice: (price) =>
        set((state) => {
          state.selectedPrice = price;
        }),

      updateOrderbook: (marketId, bids, asks) =>
        set((state) => {
          if (state.selectedMarketId === marketId) {
            state.orderbook = {
              market_id: marketId,
              bids,
              asks,
              timestamp: Date.now(),
            };
          }
        }),

      addTrade: (trade) =>
        set((state) => {
          if (state.selectedMarketId === trade.market_id) {
            state.recentTrades.unshift(trade);
            if (state.recentTrades.length > 100) {
              state.recentTrades = state.recentTrades.slice(0, 100);
            }
          }

          // Update latest price for this market's base token
          const market = state.markets[trade.market_id];
          if (market && market.quote_ticker === "USDC") {
            state.latestPrices[market.base_ticker] = trade.priceValue;
          }
        }),

      // ========================================================================
      // User Data Actions
      // ========================================================================

      setUser: (address) =>
        set((state) => {
          state.userAddress = address;
          state.isAuthenticated = true;
        }),

      clearUser: () =>
        set((state) => {
          state.userAddress = null;
          state.isAuthenticated = false;
          state.userBalances = {};
          state.chainBalanceSlices = [];
          state.userOrders = {};
          state.userTrades = [];
        }),

      connectWallet: (wallet) =>
        set((state) => {
          state.connectedWallets[wallet.id] = wallet;
          // Auto-activate if first wallet
          if (!state.activeWalletId) {
            state.activeWalletId = wallet.id;
            state.userAddress = wallet.address;
            state.isAuthenticated = true;
          }
        }),

      disconnectWallet: (walletId) =>
        set((state) => {
          delete state.connectedWallets[walletId];

          if (state.activeWalletId === walletId) {
            // Switch to another wallet if available
            const remaining = Object.keys(state.connectedWallets);
            const nextId = remaining[0];
            if (nextId) {
              state.activeWalletId = nextId;
              state.userAddress = state.connectedWallets[nextId]!.address;
              state.isAuthenticated = true;
            } else {
              state.activeWalletId = null;
              state.userAddress = null;
              state.isAuthenticated = false;
            }
            // Clear stale user data so hooks re-fetch
            state.userBalances = {};
            state.userOrders = {};
            state.userTrades = [];
          }
        }),

      setActiveWallet: (walletId) =>
        set((state) => {
          const wallet = state.connectedWallets[walletId];
          if (!wallet) return;

          state.activeWalletId = walletId;
          state.userAddress = wallet.address;
          state.isAuthenticated = true;
          // Clear stale user data so hooks re-fetch for new address
          state.userBalances = {};
          state.chainBalanceSlices = [];
          state.userOrders = {};
          state.userTrades = [];
        }),

      setBalances: (balances) =>
        set((state) => {
          // Convert array to Record keyed by token_ticker
          state.userBalances = balances.reduce(
            (acc, balance) => {
              acc[balance.token_ticker] = balance;
              return acc;
            },
            {} as Record<string, Balance>,
          );
        }),

      setChainBalanceSlices: (slices) =>
        set((state) => {
          state.chainBalanceSlices = slices;
        }),

      recordCancelledOrder: (entry) =>
        set((state) => {
          // De-dup by orderId in case a cancel retry double-fires.
          const existingIdx = state.cancelledOrders.findIndex(
            (e) => e.orderId === entry.orderId,
          );
          if (existingIdx >= 0) {
            state.cancelledOrders[existingIdx] = entry;
          } else {
            state.cancelledOrders.push(entry);
          }
          saveCancelledOrders(state.cancelledOrders);
        }),

      updateBalance: (tokenTicker, available, locked) =>
        set((state) => {
          const existing = state.userBalances[tokenTicker];
          const totalAmount = (BigInt(available) + BigInt(locked)).toString();
          const token = state.tokens[tokenTicker];
          if (!token) return;

          const divisor = Math.pow(10, token.decimals);
          const amountValue = Number(BigInt(totalAmount)) / divisor;
          const lockedValue = Number(BigInt(locked)) / divisor;

          // O(1) insert or update - handles both new and existing balances
          state.userBalances[tokenTicker] = {
            token_ticker: tokenTicker,
            user_address: existing?.user_address || state.userAddress || "",
            amount: totalAmount,
            open_interest: locked,
            locked: locked,
            updated_at: new Date().toISOString(),
            amountDisplay: amountValue.toFixed(token.decimals),
            displayAmount: amountValue.toFixed(token.decimals),
            displayOpenInterest: lockedValue.toFixed(token.decimals),
            available: (amountValue - lockedValue).toFixed(token.decimals),
            displayAvailable: (amountValue - lockedValue).toFixed(
              token.decimals,
            ),
            amountValue,
            lockedValue,
          };
        }),

      setOrders: (orders) =>
        set((state) => {
          // Convert array to Record keyed by order id
          state.userOrders = orders.reduce(
            (acc, order) => {
              acc[order.id] = order;
              return acc;
            },
            {} as Record<string, Order>,
          );
        }),

      updateOrder: (orderId, status, filledSize) =>
        set((state) => {
          const existing = state.userOrders[orderId];
          if (!existing) {
            // Order not in store yet - it will be fetched on next refetch
            console.warn(`Order ${orderId} not found in store for update`);
            return;
          }

          const market = state.markets[existing.market_id];
          if (!market) return;

          const baseToken = state.tokens[market.base_ticker];
          if (!baseToken) return;

          const divisor = Math.pow(10, baseToken.decimals);
          const filledValue = Number(BigInt(filledSize)) / divisor;

          // O(1) update - directly update the order in the Record
          state.userOrders[orderId] = {
            ...existing,
            status,
            filled_size: filledSize,
            filledDisplay: filledValue.toFixed(baseToken.decimals),
            filledValue,
          };
        }),

      setUserTrades: (trades) =>
        set((state) => {
          state.userTrades = trades;
        }),

      addUserTrade: (trade) =>
        set((state) => {
          state.userTrades.unshift(trade);
          if (state.userTrades.length > 100) {
            state.userTrades = state.userTrades.slice(0, 100);
          }

          // Update latest price for this market's base token
          const market = state.markets[trade.market_id];
          if (market && market.quote_ticker === "USDC") {
            state.latestPrices[market.base_ticker] = trade.priceValue;
          }
        }),

      // ========================================================================
      // Utilities
      // ========================================================================

      reset: () => set(initialState),
    })),
    { name: "ExchangeStore" },
  ),
);

// ============================================================================
// Selectors (for optimized re-renders)
// ============================================================================

// Stable empty arrays to prevent unnecessary re-renders
const EMPTY_ARRAY: OrderbookLevel[] = [];

export const selectSelectedMarket = (state: ExchangeState) =>
  state.selectedMarketId ? state.markets[state.selectedMarketId] : undefined;

export const selectOrderbookBids = (state: ExchangeState) =>
  state.orderbook?.bids ?? EMPTY_ARRAY;

export const selectOrderbookAsks = (state: ExchangeState) =>
  state.orderbook?.asks ?? EMPTY_ARRAY;

export const selectRecentTrades = (state: ExchangeState) => state.recentTrades;
