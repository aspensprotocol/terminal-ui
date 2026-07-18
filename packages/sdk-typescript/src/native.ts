/**
 * Native-asset identities — the EVM sentinel address and the WSOL mint.
 *
 * Mirrors the Rust SDK (`aspens::evm::NATIVE_TOKEN_SENTINEL`,
 * `aspens::solana::WSOL_MINT`) and the on-chain `MidribV3.NATIVE` constant.
 */

/**
 * The sentinel "token address" keying the chain's native asset (ETH/FLR) in
 * MidribV3 (`MidribV3.NATIVE`). A token configured with this address is the
 * native asset: deposit via the payable `depositNative` (no ERC-20 approve),
 * withdraw via the same voucher flow (paid out as raw value).
 */
export const NATIVE_TOKEN_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** `true` if `addr` is the native-asset sentinel (hex is case-insensitive). */
export function isNativeToken(addr: string): boolean {
  return addr.toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase();
}

/**
 * The WSOL (wrapped native SOL) mint — native SOL's on-venue identity. A
 * deposit/withdraw against this mint is a native-SOL flow: clients wrap
 * (system transfer + SyncNative) before depositing and unwrap (CloseAccount)
 * after withdrawing; the on-chain midrib program treats it as an ordinary
 * SPL mint throughout.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** `true` if `mint` is the WSOL mint (base58 is case-sensitive; exact match). */
export function isWsolMint(mint: string): boolean {
  return mint === WSOL_MINT;
}
