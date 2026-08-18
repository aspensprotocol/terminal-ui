/**
 * Cross-repo pinning tests for the Solana voucher-withdrawal builders.
 *
 * Every expected value below was PRINTED BY THE RUST SDK
 * (`sdk/aspens/src/solana/mod.rs` — `withdraw_voucher_ix`,
 * `withdrawal_voucher_signing_message`, `ed25519_verify_ix`, and the PDA
 * derivations) for the same fixture inputs, so these are parity assertions
 * against the reference implementation rather than a round trip against
 * this module.
 *
 * The two hazards being pinned are both SILENT:
 *   - Anchor binds accounts POSITIONALLY, so a dropped or reordered entry
 *     makes the program reinterpret whatever sits at that index instead of
 *     erroring. `withdraw_epoch` (index 7) was once omitted from the Rust
 *     SDK while its whole suite stayed green.
 *   - Borsh is positional and unframed, so a field written at the wrong
 *     width skews every field after it without any error.
 *
 * Fixture values are chosen so a wrong implementation gives a VISIBLY
 * different answer: six distinct pubkeys, an amount and nonce that both
 * exceed 2^32 (a u32/u64 mix-up shows), a deadline whose bytes are all
 * distinct (0x12345678 — a wrong endianness shows), and a signature whose
 * 64 bytes are neither uniform nor palindromic (a wrong offset or a
 * reversed slice shows).
 */

import { describe, expect, test } from "bun:test";
import { Ed25519Program, PublicKey, SystemProgram } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";

import {
  ED25519_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  anchorIxDiscriminator,
  buildWithdrawVoucherIxs,
  closeAccountIx,
  deriveAssociatedTokenAccount,
  deriveWithdrawEpochPda,
  deriveWithdrawNoncePda,
  ed25519VerifyIx,
  withdrawVoucherIx,
  withdrawalVoucherSigningMessage,
} from "./solana-ix.js";

// -- Fixtures, verbatim from the Rust vector -------------------------------

const PROGRAM_ID = new PublicKey(
  "BNSrVZTVf6yh3EkwDsEdys7QVvsRstnSCQN2z8vJLSun",
);
const INSTANCE = new PublicKey("3FdTUwGni7VUBtygzrJo85Q2kTJDNJFy9fqxeTrQZ3WR");
const ACCOUNT = new PublicKey("7PyY9AVjiokm3ZFs3hPoaPGkAayXLjFCS5iyTtkjW2zn");
const MINT = new PublicKey("ECrjizphNEohonb9xT7qaZZTsLa5ymFfd5nmMcv46oy5");
const PAYER = new PublicKey("9XpBj9TnV1dp4ChxaBBbAHNDijLJgHQDrY7Jb3j7gkSQ");
const SIGNER_PK = new PublicKey("52ySymibdVbxrV5QFkGy1KhkTU8aC8bTBh2ZwTr7xx1s");
/** The Rust vector's `derive_associated_token_account(account, mint)`. */
const USER_ATA = new PublicKey("9VE3rfingUVmGRCrrKZrc4oYbKJcCpaHqywyj2T3nQ2t");

const AMOUNT = 123_456_789_012_345n;
const NONCE = 7_842_913_005n;
const DEADLINE = 305_419_896n; // 0x12345678

/** signature[i] = (i * 7 + 3) & 0xff — non-uniform and not a palindrome. */
const SIGNATURE = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);

/** `withdrawal_voucher_signing_message(...)` — 120 borsh bytes. */
const SIGNING_MESSAGE_HEX =
  "2176ba0d5c9338ef118467d24ba91c70e335588a0fc6922774db1960a53ecc02" +
  "5f08d36a9724b14ee87b02c539966da0174cf3812abe5509d763881fb4407103" +
  "c4318e6b02f7591da840932ce67518bf0a53d964278c11f236ab7d50991b6804" +
  "79df0d8648700000ed5a79d3010000007856341200000000";

/** `withdraw_voucher_ix(...).data` — discriminator + 3×u64 + 64-byte sig. */
const WITHDRAW_IX_DATA_HEX =
  "f78fcc8af4111feb" +
  "79df0d8648700000ed5a79d3010000007856341200000000" +
  "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc" +
  "e3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bc";

/** `ed25519_verify_ix(signer, sig, msg).data` — header ‖ sig ‖ pk ‖ msg. */
const ED25519_IX_DATA_HEX =
  "01001000ffff5000ffff70007800ffff" +
  "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc" +
  "e3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bc" +
  "3bf02784d15a6c09e732954ea31870dd26c9036fb8411e5782f40b99632ea706" +
  SIGNING_MESSAGE_HEX;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function voucherIx() {
  return withdrawVoucherIx({
    programId: PROGRAM_ID,
    instance: INSTANCE,
    account: ACCOUNT,
    mint: MINT,
    userTokenAccount: USER_ATA,
    payer: PAYER,
    amount: AMOUNT,
    nonce: NONCE,
    deadline: DEADLINE,
    signature: SIGNATURE,
  });
}

describe("withdraw_voucher account list", () => {
  /**
   * Pins order, length, pubkey, and the writable/signer flags against the
   * program's `WithdrawVoucher` accounts struct
   * (`arborter/chains/solana/programs/midrib/src/instructions/
   * withdraw_voucher.rs`, field order top to bottom).
   *
   * The PDA addresses are the Rust vector's, so a wrong SEED order or a
   * wrong seed string fails here too — not just a wrong account order.
   *
   * REGENERATE from the built IDL, never from memory:
   *   cd arborter/chains/solana
   *   anchor idl build -o /tmp/midrib.json -p midrib
   *   jq -r '.instructions[] | select(.name=="withdraw_voucher")
   *          | .accounts[] | .name' /tmp/midrib.json
   */
  test("matches the program's WithdrawVoucher struct, in order", () => {
    const ix = voucherIx();
    // (name, pubkey, writable, signer) — index i here is account i on-chain.
    const expected: [string, string, boolean, boolean][] = [
      [
        "instance",
        "3FdTUwGni7VUBtygzrJo85Q2kTJDNJFy9fqxeTrQZ3WR",
        false,
        false,
      ],
      ["mint", "ECrjizphNEohonb9xT7qaZZTsLa5ymFfd5nmMcv46oy5", false, false],
      [
        "user_balance",
        "77uTXH7SkekLMDdAFj7Uk4GJixodXo1XW7e4461u9Akb",
        true,
        false,
      ],
      [
        "user_token_account",
        "9VE3rfingUVmGRCrrKZrc4oYbKJcCpaHqywyj2T3nQ2t",
        true,
        false,
      ],
      [
        "instance_vault",
        "3ionPWz45V7Cf3cBX4UBAvkToK8Soj3GLutNte3yot3E",
        true,
        false,
      ],
      [
        "vault_authority",
        "8wbQ9mJZXamH1pFQYojqucoihsDDx66ybGGMA9UfyTni",
        false,
        false,
      ],
      [
        "used_nonce",
        "b73PHhZQ4sRbeAmKx9dm5h9JhLcAi72f9QDB58m1q2e",
        true,
        false,
      ],
      [
        "withdraw_epoch",
        "3uadYKFtiykzpLtUEjLow8w3ygEMyUR6Mqs8BJCEt9cL",
        true,
        false,
      ],
      ["account", "7PyY9AVjiokm3ZFs3hPoaPGkAayXLjFCS5iyTtkjW2zn", false, false],
      ["payer", "9XpBj9TnV1dp4ChxaBBbAHNDijLJgHQDrY7Jb3j7gkSQ", true, true],
      [
        "instructions",
        "Sysvar1nstructions1111111111111111111111111",
        false,
        false,
      ],
      [
        "token_program",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        false,
        false,
      ],
      ["system_program", "11111111111111111111111111111111", false, false],
    ];

    expect(ix.keys.length).toBe(expected.length);
    const got = ix.keys.map(
      (k) => `${k.pubkey.toBase58()} w=${k.isWritable} s=${k.isSigner}`,
    );
    const want = expected.map(([, pk, w, s]) => `${pk} w=${w} s=${s}`);
    // Compared as whole arrays so a SHIFT reports every displaced slot,
    // not just the first mismatch.
    expect(got).toEqual(want);
    expect(ix.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
  });

  test("no account is duplicated — a shift would collapse two slots", () => {
    const keys = voucherIx().keys.map((k) => k.pubkey.toBase58());
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("payer is the only signer", () => {
    const signers = voucherIx()
      .keys.filter((k) => k.isSigner)
      .map((k) => k.pubkey.toBase58());
    expect(signers).toEqual([PAYER.toBase58()]);
  });
});

describe("PDA derivations", () => {
  test("withdraw-nonce PDA matches the Rust vector", () => {
    expect(
      deriveWithdrawNoncePda(INSTANCE, ACCOUNT, NONCE, PROGRAM_ID).toBase58(),
    ).toBe("b73PHhZQ4sRbeAmKx9dm5h9JhLcAi72f9QDB58m1q2e");
  });

  test("withdraw-nonce PDA is nonce-specific", () => {
    const a = deriveWithdrawNoncePda(INSTANCE, ACCOUNT, NONCE, PROGRAM_ID);
    const b = deriveWithdrawNoncePda(INSTANCE, ACCOUNT, NONCE + 1n, PROGRAM_ID);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  test("withdraw-epoch PDA matches the Rust vector", () => {
    expect(deriveWithdrawEpochPda(INSTANCE, MINT, PROGRAM_ID).toBase58()).toBe(
      "3uadYKFtiykzpLtUEjLow8w3ygEMyUR6Mqs8BJCEt9cL",
    );
  });

  test("destination ATA matches the Rust vector", () => {
    expect(deriveAssociatedTokenAccount(ACCOUNT, MINT).toBase58()).toBe(
      USER_ATA.toBase58(),
    );
  });
});

describe("instruction data encoding", () => {
  test('discriminator is sha256("global:withdraw_voucher")[..8]', () => {
    const disc = anchorIxDiscriminator("withdraw_voucher");
    expect(hex(disc)).toBe("f78fcc8af4111feb");
    expect(hex(disc)).toBe(
      hex(
        sha256(new TextEncoder().encode("global:withdraw_voucher")).slice(0, 8),
      ),
    );
  });

  test("args encode byte-for-byte like the Rust borsh layout", () => {
    const data = new Uint8Array(voucherIx().data);
    expect(hex(data)).toBe(WITHDRAW_IX_DATA_HEX);
    // 8 disc + 3×u64 + 64-byte fixed array (no borsh length prefix).
    expect(data.length).toBe(8 + 8 + 8 + 8 + 64);
    // The signature is a fixed-size array: the byte right after the three
    // u64s is signature[0], with no 4-byte length in between.
    expect(data[32]).toBe(SIGNATURE[0]!);
    expect(data[95]).toBe(SIGNATURE[63]!);
  });

  test("refuses a signature that is not 64 bytes", () => {
    expect(() =>
      withdrawVoucherIx({
        programId: PROGRAM_ID,
        instance: INSTANCE,
        account: ACCOUNT,
        mint: MINT,
        userTokenAccount: USER_ATA,
        payer: PAYER,
        amount: AMOUNT,
        nonce: NONCE,
        deadline: DEADLINE,
        signature: SIGNATURE.slice(0, 63),
      }),
    ).toThrow(/64 bytes/);
  });

  test("refuses a u64 field that would silently truncate", () => {
    const base = {
      programId: PROGRAM_ID,
      instance: INSTANCE,
      account: ACCOUNT,
      mint: MINT,
      userTokenAccount: USER_ATA,
      payer: PAYER,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: DEADLINE,
      signature: SIGNATURE,
    };
    const tooBig = 1n << 64n;
    expect(() => withdrawVoucherIx({ ...base, amount: tooBig })).toThrow(
      /amount does not fit in a u64/,
    );
    expect(() => withdrawVoucherIx({ ...base, nonce: tooBig })).toThrow(
      /nonce does not fit in a u64/,
    );
    expect(() => withdrawVoucherIx({ ...base, deadline: tooBig })).toThrow(
      /deadline does not fit in a u64/,
    );
    expect(() => withdrawVoucherIx({ ...base, amount: -1n })).toThrow(
      /amount does not fit in a u64/,
    );
  });
});

describe("withdrawal voucher signing message", () => {
  test("matches the Rust withdrawal_voucher_signing_message vector", () => {
    const msg = withdrawalVoucherSigningMessage({
      instance: INSTANCE,
      account: ACCOUNT,
      mint: MINT,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: DEADLINE,
    });
    expect(hex(msg)).toBe(SIGNING_MESSAGE_HEX);
    expect(msg.length).toBe(32 * 3 + 8 * 3);
  });

  test("field ORDER is pinned — instance, account, mint are not interchangeable", () => {
    // Swapping any two of the three pubkeys must change the bytes. Without
    // this, three distinct-but-same-length fields could be permuted and the
    // length assertion above would still pass.
    const swapped = withdrawalVoucherSigningMessage({
      instance: ACCOUNT,
      account: INSTANCE,
      mint: MINT,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: DEADLINE,
    });
    expect(hex(swapped)).not.toBe(SIGNING_MESSAGE_HEX);
    const mintSwapped = withdrawalVoucherSigningMessage({
      instance: INSTANCE,
      account: MINT,
      mint: ACCOUNT,
      amount: AMOUNT,
      nonce: NONCE,
      deadline: DEADLINE,
    });
    expect(hex(mintSwapped)).not.toBe(SIGNING_MESSAGE_HEX);
  });

  test("amount, nonce and deadline occupy their own 8-byte slots", () => {
    // Same three numbers, rotated. If any pair shared a slot or a width the
    // encoding would collide.
    const rotated = withdrawalVoucherSigningMessage({
      instance: INSTANCE,
      account: ACCOUNT,
      mint: MINT,
      amount: NONCE,
      nonce: DEADLINE,
      deadline: AMOUNT,
    });
    expect(hex(rotated)).not.toBe(SIGNING_MESSAGE_HEX);
    expect(hex(rotated).slice(0, 192)).toBe(SIGNING_MESSAGE_HEX.slice(0, 192));
  });
});

describe("ed25519 precompile instruction", () => {
  const message = withdrawalVoucherSigningMessage({
    instance: INSTANCE,
    account: ACCOUNT,
    mint: MINT,
    amount: AMOUNT,
    nonce: NONCE,
    deadline: DEADLINE,
  });

  test("matches the Rust ed25519_verify_ix vector", () => {
    const ix = ed25519VerifyIx(SIGNER_PK.toBytes(), SIGNATURE, message);
    expect(hex(new Uint8Array(ix.data))).toBe(ED25519_IX_DATA_HEX);
    expect(ix.programId.toBase58()).toBe(
      "Ed25519SigVerify111111111111111111111111111",
    );
    expect(ix.keys.length).toBe(0);
  });

  test("decodes to the same regions as web3.js's own Ed25519Program encoder", () => {
    // An INDEPENDENT implementation of the same precompile — it catches a
    // header field transcribed the same wrong way in both the Rust and the
    // TypeScript port.
    //
    // The two are NOT byte-identical and are not meant to be: web3.js lays
    // the payload out as pubkey‖signature‖message while the Rust reference
    // (and this port, which mirrors it) uses signature‖pubkey‖message. The
    // precompile and the midrib program both locate every region through
    // the header offsets, so either layout verifies — which is exactly why
    // the comparison has to be on the DECODED regions, not the raw bytes.
    const ours = new Uint8Array(
      ed25519VerifyIx(SIGNER_PK.toBytes(), SIGNATURE, message).data,
    );
    const theirs = new Uint8Array(
      Ed25519Program.createInstructionWithPublicKey({
        publicKey: SIGNER_PK.toBytes(),
        signature: SIGNATURE,
        message,
      }).data,
    );
    const decode = (data: Uint8Array) => {
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const sigOff = v.getUint16(2, true);
      const pkOff = v.getUint16(6, true);
      const msgOff = v.getUint16(10, true);
      const msgLen = v.getUint16(12, true);
      return {
        numSignatures: data[0],
        selfReferential:
          v.getUint16(4, true) === 0xffff &&
          v.getUint16(8, true) === 0xffff &&
          v.getUint16(14, true) === 0xffff,
        signature: hex(data.slice(sigOff, sigOff + 64)),
        pubkey: hex(data.slice(pkOff, pkOff + 32)),
        message: hex(data.slice(msgOff, msgOff + msgLen)),
      };
    };
    expect(decode(ours)).toEqual(decode(theirs));
    expect(decode(ours).signature).toBe(hex(SIGNATURE));
    expect(decode(ours).pubkey).toBe(hex(SIGNER_PK.toBytes()));
    expect(decode(ours).message).toBe(SIGNING_MESSAGE_HEX);
  });

  test("all three ix_index fields are 0xFFFF (self-referential)", () => {
    // The program REQUIRES this: a layout pointing at another instruction
    // would let the precompile verify one payload while the withdraw
    // executes a different one.
    const data = new Uint8Array(
      ed25519VerifyIx(SIGNER_PK.toBytes(), SIGNATURE, message).data,
    );
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(data[0]).toBe(1); // num_signatures
    expect(view.getUint16(4, true)).toBe(0xffff);
    expect(view.getUint16(8, true)).toBe(0xffff);
    expect(view.getUint16(14, true)).toBe(0xffff);
    // Offsets point exactly at the sig / pubkey / message regions.
    expect(view.getUint16(2, true)).toBe(16);
    expect(view.getUint16(6, true)).toBe(80);
    expect(view.getUint16(10, true)).toBe(112);
    expect(view.getUint16(12, true)).toBe(message.length);
  });

  test("refuses wrong-sized pubkey or signature", () => {
    expect(() =>
      ed25519VerifyIx(SIGNER_PK.toBytes().slice(0, 31), SIGNATURE, message),
    ).toThrow(/32 bytes/);
    expect(() =>
      ed25519VerifyIx(SIGNER_PK.toBytes(), SIGNATURE.slice(0, 63), message),
    ).toThrow(/64 bytes/);
  });
});

describe("transaction assembly", () => {
  const base = {
    programId: PROGRAM_ID,
    instance: INSTANCE,
    account: ACCOUNT,
    mint: MINT,
    payer: ACCOUNT, // the withdrawer submits their own withdrawal
    signerPubkey: SIGNER_PK,
    amount: AMOUNT,
    nonce: NONCE,
    deadline: DEADLINE,
    signature: SIGNATURE,
  };

  test("orders [create-ATA, ed25519 verify, withdraw_voucher]", () => {
    const ixs = buildWithdrawVoucherIxs(base);
    expect(ixs.length).toBe(3);
    expect(ixs[0]!.programId.toBase58()).toBe(
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    );
    expect(ixs[1]!.programId.toBase58()).toBe(ED25519_PROGRAM_ID.toBase58());
    expect(ixs[2]!.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
  });

  test("the ed25519 ix sits IMMEDIATELY before the withdraw", () => {
    // The program loads the sibling at `current_index - 1`; anything
    // between the two makes it read the wrong instruction.
    const ixs = buildWithdrawVoucherIxs({ ...base, unwrapNative: true });
    const withdrawIdx = ixs.findIndex((ix) => ix.programId.equals(PROGRAM_ID));
    expect(withdrawIdx).toBeGreaterThan(0);
    expect(ixs[withdrawIdx - 1]!.programId.equals(ED25519_PROGRAM_ID)).toBe(
      true,
    );
  });

  test("the verified message is the withdraw's own payload", () => {
    // The precompile's message region must be exactly what the program
    // re-derives from the withdraw ix's accounts + args, or the tx reverts
    // with SignedPayloadMismatch after the off-chain hold is placed.
    const ixs = buildWithdrawVoucherIxs(base);
    const edData = new Uint8Array(ixs[1]!.data);
    const messageRegion = edData.slice(112);
    expect(hex(messageRegion)).toBe(SIGNING_MESSAGE_HEX);
    // ...and the withdraw ix's accounts are the ones that payload names.
    const keys = ixs[2]!.keys;
    expect(keys[0]!.pubkey.toBase58()).toBe(INSTANCE.toBase58());
    expect(keys[1]!.pubkey.toBase58()).toBe(MINT.toBase58());
    expect(keys[8]!.pubkey.toBase58()).toBe(ACCOUNT.toBase58());
  });

  test("unwrapNative appends CloseAccount LAST, after the withdraw", () => {
    const ixs = buildWithdrawVoucherIxs({ ...base, unwrapNative: true });
    expect(ixs.length).toBe(4);
    const close = ixs[3]!;
    const expected = closeAccountIx(USER_ATA, ACCOUNT, ACCOUNT);
    expect(close.programId.toBase58()).toBe(SPL_TOKEN_PROGRAM_ID.toBase58());
    expect(new Uint8Array(close.data)).toEqual(new Uint8Array(expected.data));
    expect(close.keys.map((k) => k.pubkey.toBase58())).toEqual(
      expected.keys.map((k) => k.pubkey.toBase58()),
    );
    // It must come AFTER the withdraw — closing first would send the
    // vault's transfer into a closed account.
    expect(ixs[2]!.programId.equals(PROGRAM_ID)).toBe(true);
  });

  test("no CloseAccount without the toggle", () => {
    for (const opts of [base, { ...base, unwrapNative: false }]) {
      const ixs = buildWithdrawVoucherIxs(opts);
      expect(
        ixs.some(
          (ix) =>
            ix.programId.equals(SPL_TOKEN_PROGRAM_ID) &&
            new Uint8Array(ix.data)[0] === 9,
        ),
      ).toBe(false);
    }
  });

  test("refuses to unwrap when the payer is not the withdrawer", () => {
    // CloseAccount drains the ATA's entire balance to the destination, so
    // a third-party submitter must never be able to attach one.
    expect(() =>
      buildWithdrawVoucherIxs({
        ...base,
        payer: PAYER,
        unwrapNative: true,
      }),
    ).toThrow(/payer is the withdrawer/);
  });

  test("the create-ATA targets the withdrawer's ATA, not the payer's", () => {
    const ixs = buildWithdrawVoucherIxs({ ...base, payer: PAYER });
    const ata = ixs[0]!.keys;
    expect(ata[0]!.pubkey.toBase58()).toBe(PAYER.toBase58()); // rent payer
    expect(ata[1]!.pubkey.toBase58()).toBe(USER_ATA.toBase58());
    expect(ata[2]!.pubkey.toBase58()).toBe(ACCOUNT.toBase58()); // owner
    expect(ata[3]!.pubkey.toBase58()).toBe(MINT.toBase58());
    expect(ata[4]!.pubkey.toBase58()).toBe(SystemProgram.programId.toBase58());
    // ...and the withdraw's destination is that same ATA (slot 3).
    expect(ixs[2]!.keys[3]!.pubkey.toBase58()).toBe(USER_ATA.toBase58());
  });
});
