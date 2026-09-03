/**
 * The ONE way to pick which connected wallets an order's two legs use.
 *
 * The trade panel's settlement section (what the user SEES) and the submit
 * hook (what gets SIGNED) both resolve wallets from the store. They must
 * agree byte-for-byte: two same-ecosystem wallets in the store with two
 * different preference orders would show one settlement address and sign
 * another — the exact class of silent mis-settlement the settlement UI
 * exists to prevent. So both call these helpers, and neither carries its
 * own selection logic.
 */

import type { EnhancedOrder, Market } from "@aspens/terminal-sdk";
import type { ChainEcosystem, ConnectedWallet } from "./types";
import { sideLegs, type SideLegs } from "./ecosystem";

/**
 * The connected wallet to use for `ecosystem`: the ACTIVE wallet when it
 * matches, else the first connected wallet that does, else `null`.
 */
export function pickWalletForEcosystem(
  connectedWallets: Record<string, ConnectedWallet>,
  activeWalletId: string | null,
  ecosystem: ChainEcosystem | null,
): ConnectedWallet | null {
  if (ecosystem === null) return null;
  const active = activeWalletId ? connectedWallets[activeWalletId] : undefined;
  if (active?.ecosystem === ecosystem) return active;
  return (
    Object.values(connectedWallets).find((w) => w.ecosystem === ecosystem) ??
    null
  );
}

export interface SettlementWallets {
  /** The giving leg's wallet — the one that signs and pays collateral. */
  signingWallet: ConnectedWallet | null;
  /** The receiving leg's default settlement wallet, if any. */
  receivingWallet: ConnectedWallet | null;
}

/**
 * Both legs' wallets for one order. On a same-ecosystem market the
 * receiving wallet IS the signing wallet — never independently re-picked,
 * so a second same-ecosystem entry in the store can't silently split an
 * order's settlement across two wallets.
 */
export function settlementWallets(
  connectedWallets: Record<string, ConnectedWallet>,
  activeWalletId: string | null,
  legs: SideLegs,
): SettlementWallets {
  const signingWallet = pickWalletForEcosystem(
    connectedWallets,
    activeWalletId,
    legs.signingEcosystem,
  );
  const receivingWallet =
    legs.receivingEcosystem === null
      ? null
      : legs.receivingEcosystem === legs.signingEcosystem
        ? signingWallet
        : pickWalletForEcosystem(
            connectedWallets,
            activeWalletId,
            legs.receivingEcosystem,
          );
  return { signingWallet, receivingWallet };
}

/** The part of an order that decides which wallet may cancel it. */
export type CancelTarget = Pick<
  EnhancedOrder,
  "side" | "base_account_address" | "quote_account_address"
>;

/**
 * Does `wallet` hold `address`, under that wallet's own address rules?
 * EVM addresses are one key however they are cased (the venue publishes
 * lowercase, wallets report checksummed); base58 is byte-exact — two
 * strings differing in case are two different keys.
 */
function walletHolds(wallet: ConnectedWallet, address: string): boolean {
  return wallet.ecosystem === "evm"
    ? wallet.address.toLowerCase() === address.toLowerCase()
    : wallet.address === address;
}

/**
 * The connected wallet that must sign a CANCEL of `order`.
 *
 * The venue verifies a cancel against the order's wallet on its lock leg
 * — the quote-chain account for a buy, the base-chain account for a sell
 * — which is the wallet that signed the order in the first place. Which
 * wallet is ACTIVE in the UI has nothing to do with it: on a
 * cross-ecosystem market the user routinely has the other leg's wallet
 * selected, and a cancel signed by it is simply refused by the venue.
 *
 * When the order carries its account addresses (every orderbook read
 * does), the wallet is picked by that exact address, so two connected
 * wallets of one ecosystem cannot be confused either. When it does not
 * (the FCE state read), the fallback is the lock leg's ecosystem from
 * `market`, resolved the same way order placement resolves its signer.
 *
 * Throws, naming what is missing, rather than returning a wallet that
 * cannot produce a valid cancel.
 */
export function cancelSigningWallet(
  order: CancelTarget,
  market: Market | undefined,
  connectedWallets: Record<string, ConnectedWallet>,
  activeWalletId: string | null,
): ConnectedWallet {
  const lockLeg = order.side === "buy" ? "quote" : "base";
  const expected = (
    lockLeg === "quote"
      ? order.quote_account_address
      : order.base_account_address
  )?.trim();

  if (expected) {
    const match = Object.values(connectedWallets).find((w) =>
      walletHolds(w, expected),
    );
    if (match) return match;
    throw new Error(
      `Cancelling this ${order.side} order needs the wallet that placed it ` +
        `(${expected}, its ${lockLeg}-chain wallet). Connect that wallet and retry.`,
    );
  }

  if (!market) {
    throw new Error(
      "Cannot tell which wallet placed this order: it carries no account " +
        "addresses and its market is not loaded.",
    );
  }
  const ecosystem = sideLegs(market, order.side).signingEcosystem;
  if (!ecosystem) {
    throw new Error(
      `Cannot tell which wallet placed this order: its ${lockLeg}-chain ` +
        "architecture has no wallet adapter.",
    );
  }
  const wallet = pickWalletForEcosystem(
    connectedWallets,
    activeWalletId,
    ecosystem,
  );
  if (wallet) return wallet;
  throw new Error(
    `Cancelling this ${order.side} order needs ${
      ecosystem === "solana" ? "a Solana" : "an EVM"
    } wallet (the order's ${lockLeg}-chain side). Connect one and retry.`,
  );
}
