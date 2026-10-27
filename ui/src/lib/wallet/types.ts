import type { Architecture, SigningAdapter } from "@aspensprotocol/sdk-ts";

/**
 * The wallet family a chain is signed with: one per chain architecture the
 * venue runs on (`"evm" | "solana" | "tron"`), so a `switch` over it is
 * exhaustive exactly when one over the SDK's `Architecture` is.
 */
export type ChainEcosystem = Architecture;

export interface ConnectedWallet {
  /** Unique identifier: "${ecosystem}:${address}" */
  id: string;
  /** Display name of the wallet (e.g. "MetaMask", "Phantom") */
  name: string;
  /**
   * Wallet address as the venue keys it: `0x` hex for EVM and Tron (a Tron
   * wallet's `T…` address is converted on connect, and shown with
   * `hexToTron`), base58 for Solana.
   */
  address: string;
  /** Chain ecosystem */
  ecosystem: ChainEcosystem;
  /** Optional icon URL */
  icon?: string;
}

export interface WalletAdapter {
  readonly ecosystem: ChainEcosystem;
  /** Returns all currently connected wallets for this ecosystem */
  getConnectedWallets(): ConnectedWallet[];
  /** Creates a SigningAdapter for the given address */
  createSigningAdapter(address: string): SigningAdapter;
  /** Disconnects a specific wallet by address */
  disconnect(address: string): Promise<void>;
}
