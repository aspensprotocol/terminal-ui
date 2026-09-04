import type { SigningAdapter } from "@aspens/terminal-sdk";
import type { ConnectedWallet, WalletAdapter } from "./types";
import type { WalletContextState } from "@solana/wallet-adapter-react";

let walletContext: WalletContextState | null = null;

/** Called from the WalletSync component to keep the context reference up to date */
export function setSolanaWalletContext(ctx: WalletContextState | null): void {
  walletContext = ctx;
}

/**
 * Low-level escape hatch for flows that need to submit full Solana
 * transactions (deposit / withdraw). The wallet-adapter context holds
 * both the signer and the `sendTransaction(tx, connection)` helper; a
 * consumer needs it to broadcast an ix built from the SDK.
 *
 * Returns `null` when no Solana wallet is connected — callers should
 * guard on that and refuse the action rather than crashing.
 */
export function getSolanaWalletContext(): WalletContextState | null {
  return walletContext;
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

  // The wallet-adapter context holds exactly one connected key; refuse to
  // sign for any other `address` rather than produce a signature the venue
  // will reject as the wrong signer.
  createSigningAdapter(address: string): SigningAdapter {
    const assertHolds = () => {
      const connected = walletContext?.publicKey?.toBase58();
      if (connected !== address) {
        throw new Error(
          `Solana wallet ${connected ?? "(none)"} is connected, but ${address} must sign`,
        );
      }
    };
    return {
      async signMessage(hexMessage: string): Promise<string> {
        if (!walletContext?.signMessage) {
          throw new Error("Solana wallet does not support message signing");
        }
        assertHolds();
        const messageBytes = hexToBytes(hexMessage);
        const signatureBytes = await walletContext.signMessage(messageBytes);
        return bytesToHex(signatureBytes);
      },
      // Optional `SigningAdapter.signBytes`; nothing in the SDK's order or
      // cancel path calls it. Signs the raw bytes directly, avoiding the hex
      // round-trip that can mask layout bugs.
      async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
        if (!walletContext?.signMessage) {
          throw new Error("Solana wallet does not support message signing");
        }
        assertHolds();
        return walletContext.signMessage(bytes);
      },
    };
  }

  async disconnect(_address: string): Promise<void> {
    await walletContext?.disconnect();
  }
}
