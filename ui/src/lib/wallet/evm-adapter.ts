import {
  getAccount,
  disconnect as wagmiDisconnect,
  signMessage,
  signTypedData,
} from "wagmi/actions";
import type { TypedDataDefinition } from "viem";
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
      // Required for the EVM gasless path — wagmi's signTypedData calls
      // eth_signTypedData_v4 under the hood. The arborter recovers the
      // user's address from the 65-byte ECDSA sig over the EIP-712 digest.
      async signTypedData(typedData: TypedDataDefinition): Promise<string> {
        return signTypedData(
          getWagmiConfig(),
          // wagmi's type is stricter than viem's TypedDataDefinition; the
          // runtime shape is identical.
          typedData as Parameters<typeof signTypedData>[1],
        );
      },
    };
  }

  async disconnect(_address: string): Promise<void> {
    await wagmiDisconnect(getWagmiConfig());
  }
}
