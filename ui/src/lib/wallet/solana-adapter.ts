import type { SigningAdapter } from "@exchange/sdk";
import type { ConnectedWallet, WalletAdapter } from "./types";
import type { WalletContextState } from "@solana/wallet-adapter-react";

let walletContext: WalletContextState | null = null;

/** Called from the WalletSync component to keep the context reference up to date */
export function setSolanaWalletContext(ctx: WalletContextState | null): void {
  walletContext = ctx;
}

function bytesToHex(bytes: Uint8Array): string {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export class SolanaWalletAdapter implements WalletAdapter {
  readonly ecosystem = "solana" as const;

  getConnectedWallets(): ConnectedWallet[] {
    if (!walletContext?.connected || !walletContext.publicKey) return [];

    return [
      {
        id: `solana:${walletContext.publicKey.toBase58()}`,
        name: walletContext.wallet?.adapter.name ?? "Solana Wallet",
        address: walletContext.publicKey.toBase58(),
        ecosystem: "solana",
        icon: walletContext.wallet?.adapter.icon,
      },
    ];
  }

  createSigningAdapter(_address: string): SigningAdapter {
    return {
      async signMessage(hexMessage: string): Promise<string> {
        if (!walletContext?.signMessage) {
          throw new Error("Solana wallet does not support message signing");
        }
        const messageBytes = hexToBytes(hexMessage);
        const signatureBytes = await walletContext.signMessage(messageBytes);
        return bytesToHex(signatureBytes);
      },
      // Required for the Solana gasless path. The arborter rebuilds the
      // borsh payload and verifies the signature via the Ed25519SigVerify
      // precompile — signing the raw bytes directly avoids the hex
      // round-trip that can mask layout bugs.
      async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
        if (!walletContext?.signMessage) {
          throw new Error("Solana wallet does not support message signing");
        }
        return walletContext.signMessage(bytes);
      },
    };
  }

  async disconnect(_address: string): Promise<void> {
    await walletContext?.disconnect();
  }
}
