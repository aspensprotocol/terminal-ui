/**
 * Solana Midrib instruction builders — deposit and voucher withdrawal.
 *
 * Client-side counterpart to the Rust SDK's `aspens::solana` module.
 * Layouts match the on-chain `midrib` Anchor program verbatim; a drift
 * in seed order, account list, or discriminator fails program
 * validation silently.
 *
 *   data = sha256("global:<method>")[..8] || borsh(args)
 *
 * The program has no permissionless self-service `withdraw`: order
 * reservations live off-chain in the optimistic shadow ledger, so the
 * program's own `available()` check could not see them and a user could
 * drain the collateral backing a resting order. `withdraw_voucher` is
 * the only exit — the arborter (the instance's TEE `signer`) Ed25519-signs
 * a voucher over the withdrawable amount, and the submitter pairs it with
 * an Ed25519 precompile instruction placed IMMEDIATELY BEFORE the
 * withdraw, which the program introspects through the instructions sysvar.
 *
 * Two silent failure modes govern everything below, and both are pinned
 * by tests in `solana-ix.test.ts` against vectors taken from the Rust
 * implementation:
 *   - Anchor binds accounts POSITIONALLY. A missing or misordered entry
 *     is not a "missing account" error; the program reinterprets whatever
 *     sits at that index.
 *   - Borsh is positional and unframed. A field written at the wrong
 *     width does not error, it skews every following field.
 */

import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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
/**
 * Ed25519 signature-verification precompile. The `withdraw_voucher`
 * instruction requires an instruction owned by this program to sit
 * immediately before it in the same transaction.
 */
export const ED25519_PROGRAM_ID = new PublicKey(
  "Ed25519SigVerify111111111111111111111111111",
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

/**
 * Derive the single-use withdrawal-voucher tombstone PDA — seeds:
 * `b"withdraw_nonce" || instance || account || u64_le(nonce)`.
 *
 * Distinct from the settle-batch nonce seed so withdrawal and settle
 * nonces can never collide. The program `init`s this account and never
 * closes it, so replaying a voucher trips `AccountAlreadyInUse`.
 */
export function deriveWithdrawNoncePda(
  instance: PublicKey,
  account: PublicKey,
  nonce: bigint,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("withdraw_nonce"),
      instance.toBuffer(),
      account.toBuffer(),
      u64le(nonce, "nonce"),
    ],
    programId,
  );
  return pda;
}

/**
 * Derive the per-(instance, mint) WithdrawEpoch PDA — seeds:
 * `b"withdraw_epoch" || instance || mint`. Holds the per-token per-epoch
 * withdrawal cap and the running total.
 *
 * `withdraw_voucher` takes this account `init_if_needed`, so it must be
 * passed WRITABLE even on the very first withdrawal for a mint.
 */
export function deriveWithdrawEpochPda(
  instance: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("withdraw_epoch"),
      instance.toBuffer(),
      mint.toBuffer(),
    ],
    programId,
  );
  return pda;
}

/** Compute Anchor's 8-byte discriminator for an instruction method. */
export function anchorIxDiscriminator(method: string): Uint8Array {
  const h = sha256(new TextEncoder().encode(`global:${method}`));
  return h.slice(0, 8);
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * Encode a `bigint` as borsh `u64` (8 bytes, little-endian), REFUSING
 * anything that does not fit.
 *
 * Silently truncating would be a fund bug on both sides of the withdraw:
 * a truncated `amount` under-pays, a truncated `nonce` collides with
 * another voucher's tombstone PDA, and a truncated `deadline` produces a
 * slot in the past. Borsh is unframed, so none of that would error — it
 * would just land wrong.
 */
function u64le(value: bigint, field: string): Uint8Array {
  if (value < 0n || value > U64_MAX) {
    throw new Error(
      `${field} does not fit in a u64 (got ${value.toString()}); refusing to ` +
        `truncate — Solana amounts, nonces and slots are all u64`,
    );
  }
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function encodeAmountData(method: string, amount: bigint): Uint8Array {
  const disc = anchorIxDiscriminator(method);
  const out = new Uint8Array(8 + 8);
  out.set(disc, 0);
  out.set(u64le(amount, "amount"), 8);
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

// -- Withdrawal voucher ----------------------------------------------------

/** The voucher fields the arborter signs and the program re-derives. */
export interface WithdrawalVoucherFields {
  /** The trading-instance PDA the voucher is bound to. */
  instance: PublicKey;
  /** The withdrawer. Receives the funds; does NOT sign the transaction. */
  account: PublicKey;
  /** The SPL mint being withdrawn. */
  mint: PublicKey;
  /** Amount in the mint's base units. */
  amount: bigint;
  /** Single-use voucher nonce (keys the tombstone PDA). */
  nonce: bigint;
  /** Deadline as a Solana SLOT — not a unix timestamp. */
  deadline: bigint;
}

/**
 * The exact bytes the instance `signer` (TEE) Ed25519-signs to authorize a
 * `withdraw_voucher`, and the exact bytes that must appear in the paired
 * Ed25519 precompile instruction's message region.
 *
 * Borsh layout, byte-for-byte with the program's `WithdrawalVoucherPayload`:
 *
 *   instance(32) || account(32) || mint(32) || amount(u64 LE)
 *     || nonce(u64 LE) || deadline(u64 LE)     = 120 bytes
 *
 * The program compares this region by FULL-BYTES EQUALITY against its own
 * re-derivation, so any drift here is rejected on-chain rather than
 * mis-executed — but only after the voucher's off-chain hold is already
 * placed.
 */
export function withdrawalVoucherSigningMessage(
  v: WithdrawalVoucherFields,
): Uint8Array {
  const out = new Uint8Array(32 * 3 + 8 * 3);
  out.set(v.instance.toBytes(), 0);
  out.set(v.account.toBytes(), 32);
  out.set(v.mint.toBytes(), 64);
  out.set(u64le(v.amount, "amount"), 96);
  out.set(u64le(v.nonce, "nonce"), 104);
  out.set(u64le(v.deadline, "deadline"), 112);
  return out;
}

export interface WithdrawVoucherIxOpts extends WithdrawalVoucherFields {
  /** The midrib program id. */
  programId: PublicKey;
  /**
   * The withdrawer's destination SPL token account (their ATA for `mint`).
   * The program transfers into it and does NOT create it — prepend
   * `createIdempotentAtaIx` or the transaction reverts with
   * `AccountNotInitialized` (3012).
   */
  userTokenAccount: PublicKey;
  /** Fee payer + sole transaction signer; funds the two init'd PDAs. */
  payer: PublicKey;
  /** The TEE's 64-byte Ed25519 signature over the signing message. */
  signature: Uint8Array;
}

/**
 * Encode `withdraw_voucher`'s instruction data:
 * `sha256("global:withdraw_voucher")[..8] || u64 amount || u64 nonce ||
 *  u64 deadline || [u8; 64] signature` — 96 bytes.
 *
 * The signature is a fixed-size borsh array, so it carries NO length
 * prefix. It is informational on-chain (the verified copy lives in the
 * paired Ed25519 instruction), but a wrong width still skews nothing
 * after it only because it is last — do not reorder.
 */
function encodeWithdrawVoucherArgs(
  amount: bigint,
  nonce: bigint,
  deadline: bigint,
  signature: Uint8Array,
): Uint8Array {
  if (signature.length !== 64) {
    throw new Error(
      `withdraw voucher signature must be 64 bytes (Ed25519), got ${signature.length}`,
    );
  }
  const out = new Uint8Array(8 + 8 + 8 + 8 + 64);
  out.set(anchorIxDiscriminator("withdraw_voucher"), 0);
  out.set(u64le(amount, "amount"), 8);
  out.set(u64le(nonce, "nonce"), 16);
  out.set(u64le(deadline, "deadline"), 24);
  out.set(signature, 32);
  return out;
}

/**
 * Midrib `withdraw_voucher` — the only exit from the venue's custody.
 *
 * Pair it with {@link ed25519VerifyIx} over
 * {@link withdrawalVoucherSigningMessage}, placed IMMEDIATELY BEFORE this
 * instruction in the same transaction: the program loads the sibling at
 * `current_index - 1` and requires it to be an Ed25519 precompile
 * instruction proving `instance.signer` signed exactly that payload.
 * Anything between the two breaks it.
 *
 * `payer` signs and pays; `account` (the withdrawer) does NOT sign — the
 * TEE's voucher is the authorization.
 *
 * The 13 accounts below are bound POSITIONALLY by Anchor and mirror the
 * program's `WithdrawVoucher` struct field order. A dropped entry does not
 * surface as "too few accounts": every later account shifts up one slot and
 * the program reinterprets whatever now sits there. That is exactly how
 * `withdraw_epoch` (index 7) was once omitted from the Rust SDK while its
 * whole suite stayed green. `solana-ix.test.ts` pins this list; update both
 * together, and regenerate from the built IDL, never from memory:
 *
 *   cd arborter/chains/solana
 *   anchor idl build -o /tmp/midrib.json -p midrib
 *   jq -r '.instructions[] | select(.name=="withdraw_voucher")
 *          | .accounts[] | .name' /tmp/midrib.json
 */
export function withdrawVoucherIx(
  opts: WithdrawVoucherIxOpts,
): TransactionInstruction {
  const { programId, instance, account, mint } = opts;
  const userBalance = deriveUserBalancePda(instance, account, mint, programId);
  const instanceVault = deriveInstanceVaultPda(instance, mint, programId);
  const vaultAuthority = deriveVaultAuthorityPda(instance, programId);
  const usedNonce = deriveWithdrawNoncePda(
    instance,
    account,
    opts.nonce,
    programId,
  );
  const withdrawEpoch = deriveWithdrawEpochPda(instance, mint, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: instance, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: userBalance, isSigner: false, isWritable: true },
      { pubkey: opts.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: instanceVault, isSigner: false, isWritable: true },
      { pubkey: vaultAuthority, isSigner: false, isWritable: false },
      // `init` on the program side → writable, not a signer.
      { pubkey: usedNonce, isSigner: false, isWritable: true },
      // `init_if_needed` on the program side → writable, not a signer.
      { pubkey: withdrawEpoch, isSigner: false, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: false },
      { pubkey: opts.payer, isSigner: true, isWritable: true },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeWithdrawVoucherArgs(
      opts.amount,
      opts.nonce,
      opts.deadline,
      opts.signature,
    ) as unknown as Buffer,
  });
}

export interface BuildWithdrawVoucherIxsOpts extends WithdrawalVoucherFields {
  /** The midrib program id. */
  programId: PublicKey;
  /**
   * Fee payer + sole transaction signer. Also the owner of the destination
   * ATA in every flow this client drives (the connected wallet withdraws
   * its own funds), which is what makes the WSOL unwrap below safe.
   */
  payer: PublicKey;
  /** The instance's TEE signer pubkey — the key that signed the voucher. */
  signerPubkey: PublicKey;
  /** The TEE's 64-byte Ed25519 signature over the signing message. */
  signature: Uint8Array;
  /**
   * WSOL only: append a `CloseAccount` that unwraps the WSOL ATA back to
   * native SOL. Closing sends the account's ENTIRE balance, so callers must
   * only set this when `payer === account` (the withdrawer is the wallet)
   * and the mint is WSOL.
   */
  unwrapNative?: boolean;
}

/**
 * Assemble the full instruction list for a voucher withdrawal, in the ONE
 * order the program accepts:
 *
 *   0. `createIdempotentAtaIx` — the program transfers into the
 *      withdrawer's ATA but does not create it; a missing ATA reverts with
 *      `AccountNotInitialized` (3012). It goes FIRST, never between the
 *      pair below.
 *   1. `ed25519VerifyIx`   — must sit IMMEDIATELY before the withdraw.
 *   2. `withdrawVoucherIx` — reads the sysvar and checks index-1.
 *   3. optional `closeAccountIx` — the WSOL unwrap, appended AFTER the
 *      withdraw so the funds it unwraps are already in the ATA, and so it
 *      never lands between 1 and 2.
 *
 * Returning the whole list from one place is deliberate: the adjacency of
 * 1 and 2 is a program invariant that no caller should be free to
 * re-derive.
 */
export function buildWithdrawVoucherIxs(
  opts: BuildWithdrawVoucherIxsOpts,
): TransactionInstruction[] {
  const userTokenAccount = deriveAssociatedTokenAccount(
    opts.account,
    opts.mint,
  );
  const message = withdrawalVoucherSigningMessage({
    instance: opts.instance,
    account: opts.account,
    mint: opts.mint,
    amount: opts.amount,
    nonce: opts.nonce,
    deadline: opts.deadline,
  });
  const ixs = [
    createIdempotentAtaIx(
      opts.payer,
      opts.account,
      opts.mint,
      userTokenAccount,
    ),
    ed25519VerifyIx(opts.signerPubkey.toBytes(), opts.signature, message),
    withdrawVoucherIx({
      programId: opts.programId,
      instance: opts.instance,
      account: opts.account,
      mint: opts.mint,
      userTokenAccount,
      payer: opts.payer,
      amount: opts.amount,
      nonce: opts.nonce,
      deadline: opts.deadline,
      signature: opts.signature,
    }),
  ];
  if (opts.unwrapNative) {
    if (!opts.payer.equals(opts.account)) {
      throw new Error(
        "refusing to unwrap: CloseAccount sends the ATA's entire balance to " +
          "the destination, so the unwrap is only safe when the payer is the " +
          "withdrawer themself",
      );
    }
    ixs.push(closeAccountIx(userTokenAccount, opts.account, opts.account));
  }
  return ixs;
}

/**
 * Ed25519 precompile instruction proving `pubkey` signed `message`.
 *
 * Data layout — a 16-byte header, then the payload it points into:
 *
 *   u8  num_signatures      = 1
 *   u8  padding             = 0
 *   u16 signature_offset    = 16
 *   u16 signature_ix_index  = 0xFFFF (this instruction)
 *   u16 public_key_offset   = 80
 *   u16 public_key_ix_index = 0xFFFF
 *   u16 message_offset      = 112
 *   u16 message_size        = message.length
 *   u16 message_ix_index    = 0xFFFF
 *   signature(64) || pubkey(32) || message
 *
 * All three `ix_index` fields must be 0xFFFF: the midrib program rejects a
 * layout that points at any OTHER instruction, which is what stops a
 * caller from having the precompile verify one payload while the withdraw
 * executes a different one.
 */
export function ed25519VerifyIx(
  pubkey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): TransactionInstruction {
  if (pubkey.length !== 32) {
    throw new Error(`Ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
  }
  if (signature.length !== 64) {
    throw new Error(
      `Ed25519 signature must be 64 bytes, got ${signature.length}`,
    );
  }
  if (message.length > 0xffff) {
    throw new Error(
      `Ed25519 message must fit a u16 length, got ${message.length}`,
    );
  }
  const signatureOffset = 16;
  const publicKeyOffset = 16 + 64;
  const messageOffset = 16 + 64 + 32;

  const data = new Uint8Array(messageOffset + message.length);
  const view = new DataView(data.buffer);
  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  view.setUint16(2, signatureOffset, true);
  view.setUint16(4, 0xffff, true); // signature_ix_index — this instruction
  view.setUint16(6, publicKeyOffset, true);
  view.setUint16(8, 0xffff, true); // public_key_ix_index
  view.setUint16(10, messageOffset, true);
  view.setUint16(12, message.length, true);
  view.setUint16(14, 0xffff, true); // message_ix_index
  data.set(signature, signatureOffset);
  data.set(pubkey, publicKeyOffset);
  data.set(message, messageOffset);

  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data: data as unknown as Buffer,
  });
}
