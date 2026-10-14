import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { createClient, type Client, type Transport } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";

import {
  ArborterService,
  type CancelOrderRequest,
  CancelOrderRequestSchema,
  type CancelOrderResponse,
  type Order,
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
  type WithdrawRequest,
  WithdrawRequestSchema,
  type WithdrawResponse,
} from "./protos/arborter_pb.js";

import {
  ConfigService,
  type Configuration,
  type GetConfigRequest,
  GetConfigRequestSchema,
  type GetConfigResponse,
  GetSignerPublicKeyRequestSchema,
  type GetSignerPublicKeyResponse,
} from "./protos/arborter_config_pb.js";

import {
  type AttestationReport,
  type GetAttestationRequest,
  GetAttestationRequestSchema,
  type GetAttestationResponse,
} from "./protos/attestation_pb.js";

/** A typed client for `ArborterService` (orders, withdrawals, book and trade streams). */
export type ArborterClient = Client<typeof ArborterService>;
/** A typed client for `ConfigService` (configuration, attestation, signer keys). */
export type ConfigClient = Client<typeof ConfigService>;

/** A gRPC-Web transport for an arborter endpoint (normally its Envoy front). */
export function createGrpcTransport(baseUrl: string): Transport {
  return createGrpcWebTransport({ baseUrl });
}

/** A raw `ArborterService` client over `transport`. */
export function createArborterClient(transport: Transport): ArborterClient {
  return createClient(ArborterService, transport);
}

/** A raw `ConfigService` client over `transport`. */
export function createConfigClient(transport: Transport): ConfigClient {
  return createClient(ConfigService, transport);
}

// -- the default, module-wide transport -----------------------------------
//
// Kept for callers that configure one endpoint globally with
// `setGrpcBaseUrl`. An `ExchangeClient` does not use it: each client owns its
// own transport, so two clients in one app cannot redirect each other.

let grpcBaseUrl = "/api";

/**
 * Set the base URL of the default transport — the one the free stream
 * functions use when no transport is passed. Call {@link resetTransport}
 * afterwards if the default transport has already been used.
 */
export function setGrpcBaseUrl(url: string): void {
  grpcBaseUrl = url;
}

// Lazy transport creation - allows URL to be set before first use
let transport: Transport | null = null;

/** The default transport, created on first use from the default base URL. */
export function getDefaultTransport(): Transport {
  if (!transport) {
    transport = createGrpcTransport(grpcBaseUrl);
  }
  return transport;
}

/**
 * Reset the default transport (call after changing the base URL)
 */
export function resetTransport(): void {
  transport = null;
  _arborterClient = null;
  _configClient = null;
}

let _arborterClient: ArborterClient | null = null;
let _configClient: ConfigClient | null = null;

function getArborterClient(): ArborterClient {
  if (!_arborterClient) {
    _arborterClient = createArborterClient(getDefaultTransport());
  }
  return _arborterClient;
}

function getConfigClient(): ConfigClient {
  if (!_configClient) {
    _configClient = createConfigClient(getDefaultTransport());
  }
  return _configClient;
}

/**
 * Collect entries from a server stream, returning once no new entry
 * arrives within `idleMs`. This prevents hanging on the live broadcast
 * portion of streams that chain historical + live data.
 *
 * The stream is opened here, with an abort signal of its own, and cancelled
 * once collection ends: a server stream that chains history into a live
 * broadcast never ends by itself, so merely ceasing to read would leave the
 * underlying request open for the life of the page.
 */
async function collectStreamWithIdleTimeout<T>(
  open: (signal: AbortSignal) => AsyncIterable<T>,
  idleMs: number,
): Promise<T[]> {
  const entries: T[] = [];
  const abort = new AbortController();
  const iterator = open(abort.signal)[Symbol.asyncIterator]();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    while (true) {
      const nextPromise = iterator.next();
      // Cancelling below rejects a read still in flight; that rejection is
      // the expected end of this collection, not an error.
      nextPromise.catch(() => {});
      const idlePromise = new Promise<"idle">((resolve) => {
        idleTimer = setTimeout(() => resolve("idle"), idleMs);
      });

      const result = await Promise.race([nextPromise, idlePromise]);
      clearTimeout(idleTimer);

      if (result === "idle") {
        // No new entry within idle window — historical batch is done
        break;
      }

      if (result.done) break;
      entries.push(result.value);
    }
  } finally {
    clearTimeout(idleTimer);
    abort.abort();
  }

  return entries;
}

/** The configuration calls, over whichever `ConfigService` client is given. */
export function makeConfigService(getConfigClient: () => ConfigClient) {
  return {
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

    /**
     * Fetch the TEE attestation report from the arborter's signer.
     *
     * `nonce` is an optional caller-chosen freshness value (any length; 32
     * random bytes is conventional). The signer folds `SHA256(nonce)` into the
     * quote's REPORTDATA, so the returned quote *commits* to the nonce — a
     * recorded quote from before the nonce existed can never match it. Most
     * callers just want the report itself and can omit it.
     */
    async getAttestation(nonce?: Uint8Array): Promise<GetAttestationResponse> {
      try {
        const request: GetAttestationRequest = create(
          GetAttestationRequestSchema,
          nonce ? { nonce } : {},
        );
        const response = await getConfigClient().getAttestation(request);
        return response;
      } catch (error: unknown) {
        console.error("[gRPC] Failed to get attestation:", error);
        throw error;
      }
    },

    /**
     * Fetch the arborter's per-chain signer public keys.
     *
     * Unauthenticated by design. A Solana voucher withdrawal needs the
     * instance signer's Ed25519 pubkey to build the Ed25519 precompile
     * instruction the midrib program introspects — and it must be the key
     * the arborter ACTUALLY signs with, which this RPC derives, rather than
     * the `Chain.instance_signer_address` config field (a stored value that
     * can go stale after a signer rotation).
     */
    async getSignerPublicKey(
      chainNetwork?: string,
    ): Promise<GetSignerPublicKeyResponse> {
      try {
        const request = create(
          GetSignerPublicKeyRequestSchema,
          chainNetwork ? { chainNetwork } : {},
        );
        return await getConfigClient().getSignerPublicKey(request);
      } catch (error: unknown) {
        console.error("[gRPC] Failed to get signer public key:", error);
        throw error;
      }
    },
  };
}

/** The order, withdrawal and polling calls, over the `ArborterService` client given. */
export function makeArborterService(getArborterClient: () => ArborterClient) {
  return {
    async sendOrder(
      order: Order,
      signatureHash: Uint8Array,
    ): Promise<SendOrderResponse> {
      try {
        // Two fields, and that is the whole request: the arborter derives the
        // order id and the collateral it reserves from the signed `Order`
        // itself, so there is nothing for a caller to declare outside the
        // signature.
        const request: SendOrderRequest = create(SendOrderRequestSchema, {
          order,
          signatureHash,
        });

        // Add timeout wrapper
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("SendOrder request timed out after 60 seconds"));
          }, 60000);
        });

        try {
          const response: SendOrderResponse = await Promise.race([
            getArborterClient().sendOrder(request),
            timeoutPromise,
          ]);
          return response;
        } finally {
          clearTimeout(timer);
        }
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

    /**
     * Request a TEE-signed withdrawal voucher. Under the
     * optimistic shadow ledger the chain cannot self-judge a
     * withdrawal — the arborter places an off-chain hold and returns a
     * voucher the holder submits to `MidribV3.withdraw(voucher, signature)`.
     *
     * `params.signature` must be the withdrawer's signature over the
     * canonical request bytes `"network|token|account|amount"` (EIP-191
     * personal-sign on EVM, Ed25519 on Solana) — the caller signs; this
     * function only carries the request.
     */
    async requestWithdrawVoucher(params: {
      network: string;
      token: string;
      account: string;
      /** Amount in token base units, as a decimal string. */
      amount: string;
      signature: Uint8Array;
    }): Promise<WithdrawResponse> {
      try {
        const request: WithdrawRequest = create(WithdrawRequestSchema, params);
        return await getArborterClient().withdraw(request);
      } catch (error) {
        console.error("[gRPC] Error requesting withdrawal voucher:", error);
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
      historicalOpenOrders?: boolean,
      filterByTrader?: string,
    ): Promise<OrderbookEntry[]> {
      try {
        const request: OrderbookRequest = create(OrderbookRequestSchema, {
          marketId,
          historicalOpenOrders,
          filterByTrader,
        });

        return await collectStreamWithIdleTimeout(
          (signal) => getArborterClient().orderbook(request, { signal }),
          500,
        );
      } catch (error) {
        console.error("[gRPC] Failed to fetch orderbook:", error);
        return [];
      }
    },

    async getTrades(
      marketId: string,
      historicalClosedTrades?: boolean,
      filterByTrader?: string,
    ): Promise<Trade[]> {
      try {
        const request: TradeRequest = create(TradeRequestSchema, {
          marketId,
          historicalClosedTrades,
          filterByTrader,
        });

        return await collectStreamWithIdleTimeout(
          (signal) => getArborterClient().trades(request, { signal }),
          500,
        );
      } catch (error) {
        console.error("[gRPC] Failed to fetch trades:", error);
        throw error;
      }
    },
  };
}

/** The configuration calls bound to one service client. */
export type ConfigServiceCalls = ReturnType<typeof makeConfigService>;
/** The arborter calls bound to one service client. */
export type ArborterServiceCalls = ReturnType<typeof makeArborterService>;

/** Every gRPC call an `ExchangeClient` makes, bound to one transport. */
export interface GrpcServices {
  transport: Transport;
  arborterClient: ArborterClient;
  configClient: ConfigClient;
  arborter: ArborterServiceCalls;
  config: ConfigServiceCalls;
}

/** Bind the raw clients and the call wrappers to `transport`. */
export function createGrpcServices(transport: Transport): GrpcServices {
  const arborterClient = createArborterClient(transport);
  const configClient = createConfigClient(transport);
  return {
    transport,
    arborterClient,
    configClient,
    arborter: makeArborterService(() => arborterClient),
    config: makeConfigService(() => configClient),
  };
}

/** Configuration calls over the default transport. */
export const configService = makeConfigService(getConfigClient);

/** Arborter calls over the default transport. */
export const arborterService = makeArborterService(getArborterClient);

// Export protobuf types and schemas for use in other modules
export { create, OrderToCancelSchema, ArborterService, ConfigService };

export type {
  Transport,
  Trade,
  OrderbookEntry,
  Order,
  OrderToCancel,
  SendOrderResponse,
  Configuration,
  AttestationReport,
  GetAttestationResponse,
};
