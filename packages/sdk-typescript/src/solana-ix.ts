/**
 * Solana Midrib instruction builders — deposit / withdraw.
 *
 * Client-side counterpart to the Rust SDK's `aspens::solana` module.
 * Layouts match the on-chain `midrib` Anchor program verbatim; a drift
 * in seed order, account list, or discriminator fails program
 * validation silently.
 *
 *   data = sha256("global:<method>")[..8] || u64_le(amount)
 */

import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";

/** SPL Token program id — well-known constant. */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
/** SPL Associated Token Account program id. */
export const ATA_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Derive `(owner, mint)`'s associated token account (SPL ATA). */
export function deriveAssociatedTokenAccount(
  owner: PublicKey,
  mint: PublicKey,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

/** Derive UserBalance PDA — seeds: `b"balance" || instance || user || mint`. */
export function deriveUserBalancePda(
  instance: PublicKey,
  user: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("balance"),
      instance.toBuffer(),
      user.toBuffer(),
      mint.toBuffer(),
    ],
    programId,
  );
  return pda;
}

/** Derive the per-mint SPL vault PDA — seeds: `b"instance_vault" || instance || mint`. */
export function deriveInstanceVaultPda(
  instance: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("instance_vault"),
      instance.toBuffer(),
      mint.toBuffer(),
    ],
    programId,
  );
  return pda;
}

/** Derive the vault-authority PDA — seeds: `b"instance_vault" || instance`. */
export function deriveVaultAuthorityPda(
  instance: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("instance_vault"), instance.toBuffer()],
    programId,
  );
  return pda;
}

/** Compute Anchor's 8-byte discriminator for an instruction method. */
export function anchorIxDiscriminator(method: string): Uint8Array {
  const h = sha256(new TextEncoder().encode(`global:${method}`));
  return h.slice(0, 8);
}

function encodeAmountData(method: string, amount: bigint): Uint8Array {
  const disc = anchorIxDiscriminator(method);
  const out = new Uint8Array(8 + 8);
  out.set(disc, 0);
  // amount as u64 LE
  let v = amount;
  for (let i = 0; i < 8; i++) {
    out[8 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export interface DepositWithdrawIxOpts {
  programId: PublicKey;
  instance: PublicKey;
  user: PublicKey;
  mint: PublicKey;
  /** Amount in raw base units (matches mint decimals). */
  amount: bigint;
}

/**
 * Midrib `deposit` instruction. User-signed — the user's Ed25519 key
 * must sign the resulting transaction. Initialises UserBalance /
 * instance_vault PDAs on first call via the program's init_if_needed.
 */
export function depositIx(opts: DepositWithdrawIxOpts): TransactionInstruction {
  const userAta = deriveAssociatedTokenAccount(opts.user, opts.mint);
  const userBalance = deriveUserBalancePda(
    opts.instance,
    opts.user,
    opts.mint,
    opts.programId,
  );
  const instanceVault = deriveInstanceVaultPda(
    opts.instance,
    opts.mint,
    opts.programId,
  );
  const vaultAuthority = deriveVaultAuthorityPda(opts.instance, opts.programId);
  return new TransactionInstruction({
    programId: opts.programId,
    keys: [
      { pubkey: opts.instance, isSigner: false, isWritable: false },
      { pubkey: opts.mint, isSigner: false, isWritable: false },
      { pubkey: userBalance, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: instanceVault, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: opts.user, isSigner: true, isWritable: true },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    // Cast to `Buffer` — the runtime is a Uint8Array and web3.js reads
    // it bytewise; the Node-typed constructor signature is just strict.
    data: encodeAmountData("deposit", opts.amount) as unknown as Buffer,
  });
}

/** Midrib `withdraw` instruction. User-signed. */
export function withdrawIx(
  opts: DepositWithdrawIxOpts,
): TransactionInstruction {
  const userAta = deriveAssociatedTokenAccount(opts.user, opts.mint);
  const userBalance = deriveUserBalancePda(
    opts.instance,
    opts.user,
    opts.mint,
    opts.programId,
  );
  const instanceVault = deriveInstanceVaultPda(
    opts.instance,
    opts.mint,
    opts.programId,
  );
  const vaultAuthority = deriveVaultAuthorityPda(opts.instance, opts.programId);
  return new TransactionInstruction({
    programId: opts.programId,
    keys: [
      { pubkey: opts.instance, isSigner: false, isWritable: false },
      { pubkey: opts.mint, isSigner: false, isWritable: false },
      { pubkey: userBalance, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: instanceVault, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      { pubkey: opts.user, isSigner: true, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeAmountData("withdraw", opts.amount) as unknown as Buffer,
  });
}
