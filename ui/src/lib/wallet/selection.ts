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

import type { ChainEcosystem, ConnectedWallet } from "./types";
import type { SideLegs } from "./ecosystem";

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
