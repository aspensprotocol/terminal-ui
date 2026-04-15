import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";

import {
  ArborterService,
  type CancelOrderRequest,
  CancelOrderRequestSchema,
  type CancelOrderResponse,
  type Order,
  OrderSchema,
  OrderToCancelSchema,
  type OrderbookEntry,
  type OrderbookRequest,
  OrderbookRequestSchema,
  type SendOrderRequest,
  SendOrderRequestSchema,
  type SendOrderResponse,
  type Trade,
  type TradeRequest,
  TradeRequestSchema,
  type OrderToCancel,
} from "./protos/arborter_pb.js";

import {
  ConfigService,
  type Configuration,
  type GetConfigRequest,
  GetConfigRequestSchema,
  type GetConfigResponse,
} from "./protos/arborter_config_pb.js";

let grpcBaseUrl = "/api";

/**
 * Set the gRPC base URL for the transport
 */
export function setGrpcBaseUrl(url: string): void {
  grpcBaseUrl = url;
}

/**
 * Get the current gRPC base URL
 */
export function getGrpcBaseUrl(): string {
  return grpcBaseUrl;
}

/**
 * Create gRPC-Web transport with retry interceptor
 */
function createTransport() {
  return createGrpcWebTransport({
    baseUrl: grpcBaseUrl,
  });
}

// Lazy transport creation - allows URL to be set before first use
let transport: ReturnType<typeof createGrpcWebTransport> | null = null;

function getTransport() {
  if (!transport) {
    transport = createTransport();
  }
  return transport;
}

/**
 * Reset the transport (call after changing the base URL)
 */
export function resetTransport(): void {
  transport = null;
}

// Lazy client creation
let _arborterClient: ReturnType<
  typeof createClient<typeof ArborterService>
> | null = null;
let _configClient: ReturnType<
  typeof createClient<typeof ConfigService>
> | null = null;

export function getArborterClient() {
  if (!_arborterClient) {
    _arborterClient = createClient(ArborterService, getTransport());
  }
  return _arborterClient;
}

export function getConfigClient() {
  if (!_configClient) {
    _configClient = createClient(ConfigService, getTransport());
  }
  return _configClient;
}

/**
 * Collect entries from a server stream, returning once no new entry
 * arrives within `idleMs`. This prevents hanging on the live broadcast
 * portion of streams that chain historical + live data.
 */
async function collectStreamWithIdleTimeout<T>(
  stream: AsyncIterable<T>,
  idleMs: number,
): Promise<T[]> {
  const entries: T[] = [];
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    const nextPromise = iterator.next();
    const idlePromise = new Promise<"idle">((resolve) =>
      setTimeout(() => resolve("idle"), idleMs),
    );

    const result = await Promise.race([nextPromise, idlePromise]);

    if (result === "idle") {
      // No new entry within idle window — historical batch is done
      break;
    }

    if (result.done) break;
    entries.push(result.value);
  }

  return entries;
}

// Configuration service functions
export const configService = {
  async getConfig(): Promise<GetConfigResponse> {
    try {
      const request = create(GetConfigRequestSchema, {});
      const response = await getConfigClient().getConfig(request);
      return response;
    } catch (error: unknown) {
      console.error("[gRPC] Failed to get config:", error);
      throw error;
    }
  },
};

// Arborter service functions
export const arborterService = {
  async sendOrder(
    order: Order,
    signatureHash: Uint8Array,
    gasless?: import("./protos/arborter_pb.js").GaslessAuthorization,
  ): Promise<SendOrderResponse> {
    try {
      const request: SendOrderRequest = create(SendOrderRequestSchema, {
        order,
        signatureHash,
        gasless,
      });

      // Add timeout wrapper
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("SendOrder request timed out after 60 seconds"));
        }, 60000);
      });

      const response: SendOrderResponse = await Promise.race([
        getArborterClient().sendOrder(request),
        timeoutPromise,
      ]);

      return response;
    } catch (error) {
      console.error("[gRPC] Error sending order:", error);

      if (error instanceof Error) {
        const message = error.message.toLowerCase();

        if (
          message.includes("503") ||
          message.includes("service unavailable")
        ) {
          throw new Error(
            "Trading service is temporarily overloaded. Please wait and try again.",
          );
        } else if (
          message.includes("upstream connect error") ||
          message.includes("reset before headers")
        ) {
          throw new Error(
            "Connection to trading service was reset. Please try again.",
          );
        } else if (message.includes("unavailable")) {
          throw new Error(
            "Trading service is currently unavailable. Please check back later.",
          );
        } else if (
          message.includes("timeout") ||
          message.includes("deadline_exceeded")
        ) {
          throw new Error("Request timed out. Please try again.");
        } else if (
          message.includes("network error") ||
          message.includes("fetch")
        ) {
          throw new Error(
            "Network error occurred. Please check your connection.",
          );
        }
      }

      throw error;
    }
  },

  async cancelOrder(
    order: OrderToCancel,
    signatureHash: Uint8Array,
  ): Promise<CancelOrderResponse> {
    try {
      const request: CancelOrderRequest = create(CancelOrderRequestSchema, {
        order,
        signatureHash,
      });

      const response: CancelOrderResponse =
        await getArborterClient().cancelOrder(request);
      return response;
    } catch (error) {
      console.error("[gRPC] Error canceling order:", error);
      throw error;
    }
  },

  async getOrderbook(
    marketId: string,
    continueStream = false,
    historicalOpenOrders?: boolean,
    filterByTrader?: string,
  ): Promise<OrderbookEntry[]> {
    try {
      const request: OrderbookRequest = create(OrderbookRequestSchema, {
        marketId,
        continueStream,
        historicalOpenOrders,
        filterByTrader,
      });

      const response = await getArborterClient().orderbook(request);
      return await collectStreamWithIdleTimeout(response, 500);
    } catch (error) {
      console.error("[gRPC] Failed to fetch orderbook:", error);
      return [];
    }
  },

  async getTrades(
    marketId: string,
    continueStream = false,
    historicalClosedTrades?: boolean,
    filterByTrader?: string,
  ): Promise<Trade[]> {
    try {
      const request: TradeRequest = create(TradeRequestSchema, {
        marketId,
        continueStream,
        historicalClosedTrades,
        filterByTrader,
      });

      const response = await getArborterClient().trades(request);
      return await collectStreamWithIdleTimeout(response, 500);
    } catch (error) {
      console.error("[gRPC] Failed to fetch trades:", error);
      throw error;
    }
  },
};

// Export protobuf types and schemas for use in other modules
export { create, OrderSchema, OrderToCancelSchema };

export type {
  Order,
  OrderToCancel,
  OrderbookEntry,
  Trade,
  SendOrderResponse,
  CancelOrderResponse,
  Configuration,
};
