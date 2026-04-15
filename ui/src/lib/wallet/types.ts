import type { SigningAdapter } from "@aspens/terminal-sdk";

export type ChainEcosystem = "evm" | "solana";

export interface ConnectedWallet {
  /** Unique identifier: "${ecosystem}:${address}" */
  id: string;
  /** Display name of the wallet (e.g. "MetaMask", "Phantom") */
  name: string;
  /** Wallet address (hex for EVM, base58 for Solana) */
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
