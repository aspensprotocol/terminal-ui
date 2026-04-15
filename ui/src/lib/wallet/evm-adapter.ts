import {
  getAccount,
  disconnect as wagmiDisconnect,
  signMessage,
} from "wagmi/actions";
import { getWagmiConfig } from "../web3modal-config";
import type { SigningAdapter } from "@exchange/sdk";
import type { ConnectedWallet, WalletAdapter } from "./types";

export class EvmWalletAdapter implements WalletAdapter {
  readonly ecosystem = "evm" as const;

  getConnectedWallets(): ConnectedWallet[] {
    const account = getAccount(getWagmiConfig());
    if (!account.isConnected || !account.address) return [];

    return [
      {
        id: `evm:${account.address}`,
        name: account.connector?.name ?? "EVM Wallet",
        address: account.address,
        ecosystem: "evm",
        icon: account.connector?.icon,
      },
    ];
  }

  createSigningAdapter(_address: string): SigningAdapter {
    return {
      async signMessage(hexMessage: string): Promise<string> {
        const signature = await signMessage(getWagmiConfig(), {
          message: { raw: hexMessage as `0x${string}` },
        });
        return signature;
      },
    };
  }

  async disconnect(_address: string): Promise<void> {
    await wagmiDisconnect(getWagmiConfig());
  }
}
