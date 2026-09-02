/**
 * Config adapter - converts protobuf Configuration to Market[] and Token[]
 */

import type {
  Configuration,
  Market as ProtoMarket,
  Token as ProtoToken,
  Chain as ProtoChain,
} from "../protos/arborter_config_pb.js";
import type { Market, Token } from "../types.js";

/**
 * Convert a protobuf Market to SDK Market type.
 * Pass `chainByNetwork` to populate the base/quote chain architecture fields.
 */
function toMarket(
  protoMarket: ProtoMarket,
  chainByNetwork?: Map<string, ProtoChain>,
): Market {
  const baseChain = chainByNetwork?.get(protoMarket.baseChainNetwork);
  const quoteChain = chainByNetwork?.get(protoMarket.quoteChainNetwork);

  return {
    id: protoMarket.marketId,
    base_ticker: protoMarket.baseChainTokenSymbol,
    quote_ticker: protoMarket.quoteChainTokenSymbol,
    // For tick_size and lot_size, use reasonable defaults based on decimals
    // These are display-related values
    tick_size: (1 / Math.pow(10, protoMarket.pairDecimals)).toString(),
    lot_size: (1 / Math.pow(10, protoMarket.pairDecimals)).toString(),
    min_size: (1 / Math.pow(10, protoMarket.pairDecimals)).toString(),
    // Fees are not in the proto, using defaults
    maker_fee_bps: 0,
    taker_fee_bps: 0,
    // Extended fields from proto
    pairDecimals: protoMarket.pairDecimals,
    baseChainNetwork: protoMarket.baseChainNetwork,
    quoteChainNetwork: protoMarket.quoteChainNetwork,
    baseChainTokenDecimals: protoMarket.baseChainTokenDecimals,
    quoteChainTokenDecimals: protoMarket.quoteChainTokenDecimals,
    baseChainArchitecture: baseChain?.architecture,
    quoteChainArchitecture: quoteChain?.architecture,
    name: protoMarket.name,
  };
}

/**
 * Convert Configuration to an array of SDK Markets
 */
export function toMarkets(config: Configuration): Market[] {
  const chainByNetwork = new Map(config.chains.map((c) => [c.network, c]));
  return config.markets.map((m) => toMarket(m, chainByNetwork));
}

/**
 * Convert a protobuf Token to SDK Token type
 */
function toToken(protoToken: ProtoToken, chainNetwork?: string): Token {
  return {
    ticker: protoToken.symbol,
    decimals: protoToken.decimals,
    name: protoToken.name,
    address: protoToken.address,
    chainNetwork,
  };
}

/**
 * Extract all unique tokens from Configuration
 */
export function toTokens(config: Configuration): Token[] {
  const tokenMap = new Map<string, Token>();

  // Extract tokens from all chains
  for (const chain of config.chains) {
    if (chain.tokens) {
      for (const [symbol, token] of Object.entries(chain.tokens)) {
        // Use a composite key to handle same token on different chains
        const key = `${chain.network}:${symbol}`;
        if (!tokenMap.has(key)) {
          tokenMap.set(key, toToken(token, chain.network));
        }
      }
    }
  }

  return Array.from(tokenMap.values());
}

/**
 * Get pair decimals for a market from config
 */
export function getPairDecimals(
  config: Configuration,
  marketId: string,
): number {
  const market = config.markets.find((m) => m.marketId === marketId);
  return market?.pairDecimals ?? 8; // Default to 8 decimals
}
