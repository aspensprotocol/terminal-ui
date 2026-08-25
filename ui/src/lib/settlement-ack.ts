/**
 * Per-wallet acknowledgement that an EVM/EVM market settles BOTH legs to
 * the one connected address — the silent default when a single EVM wallet
 * serves a two-EVM-chain market. The first order from a wallet asks the
 * user to confirm they mean it; once confirmed it is remembered here so
 * every subsequent order shows a passive note instead of a checkbox.
 *
 * localStorage is per-browser convenience state, nothing more: it can come
 * back empty (private window, cleared site data, another device) and the
 * only consequence is being asked once again. Every access is wrapped —
 * some contexts throw on the accessor itself.
 */

const KEY_PREFIX = "aspens.settlement.same-address-ack.";

/** EVM addresses are case-insensitive; key on the canonical lowercase. */
const keyFor = (walletAddress: string) =>
  `${KEY_PREFIX}${walletAddress.toLowerCase()}`;

export function hasSameAddressAck(walletAddress: string): boolean {
  try {
    return localStorage.getItem(keyFor(walletAddress)) === "1";
  } catch {
    return false;
  }
}

export function recordSameAddressAck(walletAddress: string): void {
  try {
    localStorage.setItem(keyFor(walletAddress), "1");
  } catch {
    // Nothing to do — the user will simply be asked again next time.
  }
}
