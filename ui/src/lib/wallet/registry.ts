import type { ChainEcosystem, ConnectedWallet, WalletAdapter } from "./types";

class WalletRegistry {
  private adapters = new Map<ChainEcosystem, WalletAdapter>();

  register(adapter: WalletAdapter): void {
    this.adapters.set(adapter.ecosystem, adapter);
  }

  getAdapter(ecosystem: ChainEcosystem): WalletAdapter | undefined {
    return this.adapters.get(ecosystem);
  }

  getAllConnectedWallets(): ConnectedWallet[] {
    const wallets: ConnectedWallet[] = [];
    for (const adapter of this.adapters.values()) {
      wallets.push(...adapter.getConnectedWallets());
    }
    return wallets;
  }
}

export const walletRegistry = new WalletRegistry();
