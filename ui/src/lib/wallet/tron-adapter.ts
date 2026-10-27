/**
 * The Tron wallet: MetaMask's Tron account, reached through
 * `@tronweb3/tronwallet-adapter-metamask-tron`, bridged to the SDK's
 * `SigningAdapter`.
 *
 * - The account is the wallet's `T…` address converted to lowercase `0x`
 *   hex, the form the venue keys it by; the UI shows it back in `T…` form.
 * - `signTronMessage` hands MetaMask the TEXT the SDK chose (an order's
 *   lowercase hex, a withdraw request as is), which MetaMask signs under the
 *   TRON message prefix. Never bytes: MetaMask decodes a binary message as
 *   UTF-8 lossily, so two different orders could produce one signed text.
 * - `signTronTransaction` hands MetaMask the SDK-built `raw_data` hex
 *   unchanged (MetaMask signs `sha256(raw_data)`, which is the txID) and
 *   relays the signature it returns. The SDK recovers that signature against
 *   the account before broadcasting anything.
 * - `signMessage` (the Ethereum prefix) is refused.
 *
 * The library's adapter is created by `TronProvider`, which hands it here
 * with `setTronWallet`; this module only reads it, so it tests without the
 * library.
 */

import {
  hexToTron,
  tronToHex,
  type SigningAdapter,
} from "@aspensprotocol/sdk-ts";
import type { ConnectedWallet, WalletAdapter } from "./types";

/** The product name, matching MetaMask's EVM connector so the picker merges them. */
export const TRON_WALLET_NAME = "MetaMask";

/** MetaMask's chain id for Nile, where it cannot sign transactions. */
const NILE_CHAIN_ID_HEX = "0xcd8690dc";

/** The transaction the library's `signTransaction` takes, as this module fills it. */
export interface TronTransactionRequest {
  visible: false;
  txID: string;
  raw_data_hex: string;
  /** The library reads only the contract type; MetaMask signs `raw_data_hex`. */
  raw_data: { contract: { type: "TriggerSmartContract" }[] };
}

/** The parts of the library's `MetaMaskAdapter` this module uses. */
export interface MetaMaskTronLike {
  /** The connected account in `T…` form, or `null`. */
  readonly address: string | null;
  signMessage(message: string): Promise<string>;
  signTransaction(
    transaction: TronTransactionRequest,
  ): Promise<{ signature?: string[] }>;
  network(): Promise<{ chainId: string }>;
  switchChain(chainId: string): Promise<void>;
  disconnect(): Promise<void>;
}

let tronWallet: MetaMaskTronLike | null = null;
let venueChainIdHex: string | null = null;
let tronWalletIcon: string | undefined;

/**
 * Called by `TronProvider` with the library adapter and the MetaMask chain
 * id of the venue's Tron chain (`null` when the venue lists none).
 */
export function setTronWallet(
  wallet: MetaMaskTronLike | null,
  chainIdHex: string | null,
  icon?: string,
): void {
  tronWallet = wallet;
  venueChainIdHex = chainIdHex;
  tronWalletIcon = icon;
}

/** MetaMask's hex chain id for a Tron `chainId` (`728126428` → `0x2b6653dc`). */
export function tronChainIdHex(chainId: number | bigint): string {
  return "0x" + BigInt(chainId).toString(16);
}

/**
 * The `chainId` of the venue's Tron chain: the first configured chain whose
 * architecture is Tron, or `null` when there is none.
 */
export function tronChainIdForVenue(
  chains: readonly { architecture: string; chainId: number | bigint }[],
): number | null {
  const chain = chains.find((c) => c.architecture.toLowerCase() === "tron");
  return chain ? Number(chain.chainId) : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A wallet signature as `0x` + 130 lowercase hex digits (65 bytes). */
function normalizeSignature(signature: unknown): string {
  if (typeof signature !== "string") {
    throw new Error("MetaMask returned no Tron signature");
  }
  const body = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (!/^[0-9a-fA-F]{130}$/.test(body)) {
    throw new Error(
      `MetaMask returned a Tron signature that is not 65 bytes of hex: ${signature}`,
    );
  }
  return "0x" + body.toLowerCase();
}

/** What a refused transaction signature means, in words a user can act on. */
function transactionRefusal(err: unknown, chainIdHex: string | null): Error {
  const text = errorText(err);
  if (/insufficient funds/i.test(text)) {
    return new Error(
      "MetaMask will not sign: the Tron account cannot pay this " +
        "transaction's fee (Insufficient funds). Add TRX to it and try again.",
    );
  }
  const nile =
    chainIdHex === NILE_CHAIN_ID_HEX
      ? " MetaMask cannot sign Tron transactions on Nile (its transaction " +
        "check refuses them there); Nile deposits and withdrawals go " +
        "through the CLI."
      : "";
  return new Error(
    `MetaMask did not sign the Tron transaction: ${text}.${nile}`,
  );
}

/**
 * A `SigningAdapter` that signs as `account` (`0x` hex) with the Tron wallet
 * `wallet()` returns at call time, switching MetaMask to `chainIdHex` before
 * it signs a transaction. Each call refuses, before reaching MetaMask, when
 * no Tron wallet is connected or it holds another account.
 */
export function tronSigningAdapter(
  wallet: () => MetaMaskTronLike | null,
  account: string,
  chainIdHex: string | null,
): SigningAdapter {
  const holding = (): MetaMaskTronLike => {
    const w = wallet();
    if (!w?.address) {
      throw new Error("No Tron wallet is connected; connect MetaMask (Tron)");
    }
    if (tronToHex(w.address) !== account.toLowerCase()) {
      throw new Error(
        `MetaMask's Tron account is ${w.address}, but ` +
          `${tronDisplay(account)} must sign; switch accounts in MetaMask`,
      );
    }
    return w;
  };

  return {
    async signMessage(): Promise<string> {
      throw new Error(
        "a Tron wallet signs under the TRON message prefix (signTronMessage), " +
          "never the Ethereum one",
      );
    },

    async signTronMessage(text: string): Promise<string> {
      if (typeof text !== "string") {
        throw new Error("a Tron wallet signs text, never bytes");
      }
      const w = holding();
      let signature: string;
      try {
        signature = await w.signMessage(text);
      } catch (err) {
        throw new Error(`MetaMask did not sign the message: ${errorText(err)}`);
      }
      return normalizeSignature(signature);
    },

    async signTronTransaction(
      txId: string,
      rawDataHex: string,
    ): Promise<string> {
      const w = holding();
      if (chainIdHex !== null) {
        const current = (await w.network()).chainId;
        if (current !== chainIdHex) await w.switchChain(chainIdHex);
      }
      let signed: { signature?: string[] };
      try {
        signed = await w.signTransaction({
          visible: false,
          txID: txId,
          raw_data_hex: rawDataHex,
          raw_data: { contract: [{ type: "TriggerSmartContract" }] },
        });
      } catch (err) {
        throw transactionRefusal(err, chainIdHex);
      }
      return normalizeSignature(signed.signature?.[0]);
    },
  };
}

/** `account` in `T…` form when it is 20-byte hex, else as given. */
function tronDisplay(account: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(account) ? hexToTron(account) : account;
}

export class TronWalletAdapter implements WalletAdapter {
  readonly ecosystem = "tron" as const;

  getConnectedWallets(): ConnectedWallet[] {
    if (!tronWallet?.address) return [];
    const address = tronToHex(tronWallet.address);
    return [
      {
        id: `tron:${address}`,
        name: TRON_WALLET_NAME,
        address,
        ecosystem: "tron",
        icon: tronWalletIcon,
      },
    ];
  }

  createSigningAdapter(address: string): SigningAdapter {
    return tronSigningAdapter(() => tronWallet, address, venueChainIdHex);
  }

  async disconnect(_address: string): Promise<void> {
    await tronWallet?.disconnect();
  }
}
