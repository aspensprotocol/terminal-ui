import {
  getAccount,
  disconnect as wagmiDisconnect,
  signMessage,
  signTypedData,
} from "wagmi/actions";
import type { TypedDataDefinition } from "viem";
import { getWagmiConfig } from "../web3modal-config";
import type { SigningAdapter } from "@aspens/terminal-sdk";
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

  // The adapter signs AS `address`: wagmi checks it against the ACTIVE
  // connector's accounts and refuses (ConnectorAccountNotFound) when that
  // connector does not hold it — a loud failure instead of a signature
  // from whatever account the wallet currently has selected. It looks at
  // the active connector only; that is sufficient because the wallet sync
  // keeps at most one EVM wallet in the store at a time, so the only EVM
  // address a caller can pass is the active connector's own.
  createSigningAdapter(address: string): SigningAdapter {
    const account = address as `0x${string}`;
    return {
      async signMessage(hexMessage: string): Promise<string> {
        const signature = await signMessage(getWagmiConfig(), {
          account,
          message: { raw: hexMessage as `0x${string}` },
        });
        return signature;
      },
      // Required for the EVM gasless path — wagmi's signTypedData calls
      // eth_signTypedData_v4 under the hood. The arborter recovers the
      // user's address from the 65-byte ECDSA sig over the EIP-712 digest.
      async signTypedData(typedData: TypedDataDefinition): Promise<string> {
        return signTypedData(getWagmiConfig(), {
          // wagmi's type is stricter than viem's TypedDataDefinition; the
          // runtime shape is identical.
          ...(typedData as Parameters<typeof signTypedData>[1]),
          account,
        });
      },
    };
  }

  async disconnect(_address: string): Promise<void> {
    await wagmiDisconnect(getWagmiConfig());
  }
}
