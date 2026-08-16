/**
 * Solana Midrib instruction builders — deposit only.
 *
 * Client-side counterpart to the Rust SDK's `aspens::solana` module.
 * Layouts match the on-chain `midrib` Anchor program verbatim; a drift
 * in seed order, account list, or discriminator fails program
 * validation silently.
 *
 *   data = sha256("global:<method>")[..8] || u64_le(amount)
 *
 * There is deliberately NO withdraw builder here. The program's
 * permissionless self-service `withdraw` instruction was removed: order
 * reservations live off-chain in the optimistic shadow ledger, so the
 * program's own `available()` check could not see them and a user could
 * drain the collateral backing a resting order. The TEE-signed
 * `withdraw_voucher` instruction is the only exit, and it needs a
 * voucher fetched from the arborter plus an Ed25519 sibling instruction
 * — none of which this client implements yet. Building a `withdraw`
 * instruction again would only produce a transaction whose discriminator
 * no longer resolves (Anchor `InstructionFallbackNotFound`, 101).
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

export interface DepositIxOpts {
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
export function depositIx(opts: DepositIxOpts): TransactionInstruction {
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

// -- Native-SOL (WSOL) wrap/unwrap helpers ---------------------------------

/**
 * Idempotent "create associated token account" (ATA program discriminant 1).
 * No-op if `ata` already exists, so it is safe to submit unconditionally.
 * `payer` funds the rent (~0.002 SOL when actually created) and signs.
 */
export function createIdempotentAtaIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  ata: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]) as unknown as Buffer, // CreateIdempotent
  });
}

/**
 * SPL Token `SyncNative` (discriminant 17): syncs a WSOL token account's
 * recorded amount up to its lamport balance. Submit after a system transfer
 * of lamports into the ATA to complete a wrap.
 */
export function syncNativeIx(ata: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [{ pubkey: ata, isSigner: false, isWritable: true }],
    data: new Uint8Array([17]) as unknown as Buffer,
  });
}

/**
 * SPL Token `CloseAccount` (discriminant 9): closes `ata` and sends its
 * ENTIRE lamport balance — wrapped SOL plus rent — to `dest`. This is the
 * WSOL unwrap; it unwraps the account's whole balance, not just a withdrawn
 * amount (standard wallet behavior).
 */
export function closeAccountIx(
  ata: PublicKey,
  dest: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: new Uint8Array([9]) as unknown as Buffer,
  });
}
