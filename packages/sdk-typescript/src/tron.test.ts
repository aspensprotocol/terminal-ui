/**
 * Tron primitives against the shared vector fixture.
 *
 * `tron-vectors.json` was captured on Nile and is copied byte-identical into
 * every repo that speaks Tron (arborter, the Rust sdk, infra, here). Every
 * expected value below is a literal from that fixture, never recomputed with
 * the code under test: one byte of drift in an encoding recovers a different
 * signer or a different txID, and nothing on the wire says which field moved.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { hashMessage, recoverAddress, type Hex } from "viem";

import vectors from "./tron-vectors.json";
import {
  buildTriggerRawData,
  hexToTron,
  tronJsonRpcUrl,
  tronMessageDigest,
  tronToHex,
  tronTxId,
} from "./tron.js";
import { privateKeyTronAdapter } from "./signing.js";

const PK = vectors.test_only_private_key.private_key as Hex;
const SIGNER = vectors.test_only_private_key.address_hex;
const MSG = vectors.sign_message_v2;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string): Uint8Array {
  const body = s.startsWith("0x") ? s.slice(2) : s;
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
}

describe("the fixture", () => {
  test("is the byte-identical copy every repo pins", () => {
    const bytes = readFileSync(new URL("./tron-vectors.json", import.meta.url));
    expect(hex(sha256(new Uint8Array(bytes)))).toBe(
      "c7410b3dcf8b088d37c56365d98aa210c639a254698971c2003fdd0ef8434b05",
    );
  });
});

describe("tron vectors match the fixture: addresses", () => {
  const pairs = [
    ...vectors.addresses,
    {
      label: "test_only_private_key",
      hex: vectors.test_only_private_key.address_hex,
      tron: vectors.test_only_private_key.address_tron,
    },
  ];

  test("the fixture carries enough pairs to mean something", () => {
    expect(pairs.length).toBe(11);
  });

  for (const pair of pairs) {
    test(`${pair.label}: T-form → hex`, () => {
      expect(tronToHex(pair.tron)).toBe(pair.hex);
    });
    test(`${pair.label}: hex → T-form`, () => {
      expect(hexToTron(pair.hex)).toBe(pair.tron);
    });
  }

  test("tronToHex returns lowercase hex", () => {
    // USDT's T-form from the fixture; its hex carries letters.
    expect(tronToHex("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(
      "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c",
    );
  });

  test("hexToTron accepts any case of the hex", () => {
    expect(hexToTron("0xA614F803B6FD780986A42C78EC9C7F77E6DED13C")).toBe(
      "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    );
  });

  test("tronToHex refuses a bad checksum", () => {
    // Last character changed: still base58, still 25 bytes, checksum wrong.
    expect(() => tronToHex("TR2zV5HudeeSw37JKTwMWofufa2JL7qnst")).toThrow(
      /checksum/,
    );
  });

  test("tronToHex refuses a non-Tron version byte", () => {
    // A Bitcoin P2PKH address: valid base58check, 25 bytes, version 0x00.
    expect(() => tronToHex("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toThrow(
      /0x41/,
    );
  });

  test("tronToHex refuses what is not base58 or not 25 bytes", () => {
    expect(() => tronToHex("TR2zV5HudeeSw37JKTwMWofufa2JL7qns0")).toThrow(
      /base58/,
    );
    expect(() => tronToHex("TR2zV5Hude")).toThrow(/25/);
    expect(() => tronToHex("")).toThrow();
  });

  test("hexToTron refuses unprefixed, non-hex and wrong-length input", () => {
    expect(() => hexToTron("a5411a1a5784b0828bbafcfa588c72ef3f3ce646")).toThrow(
      /0x/,
    );
    expect(() =>
      hexToTron("0xz5411a1a5784b0828bbafcfa588c72ef3f3ce646"),
    ).toThrow(/hex/);
    expect(() => hexToTron("0xa5411a1a5784b0828bbafcfa588c72ef3f3ce6")).toThrow(
      /20/,
    );
  });
});

describe("tron vectors match the fixture: transactions", () => {
  const cases = [
    ["settle", vectors.transactions.settle],
    ["deposit_native", vectors.transactions.deposit_native],
  ] as const;

  for (const [name, tx] of cases) {
    const f = tx.fields;
    const build = () =>
      buildTriggerRawData({
        owner: f.owner_address_hex,
        contract: f.contract_address_hex,
        data: f.data as Hex,
        callValueSun: BigInt(f.call_value),
        feeLimitSun: BigInt(f.fee_limit),
        refBlock: {
          bytes: unhex(f.ref_block_bytes),
          hash: unhex(f.ref_block_hash),
          // The expiration is the head time plus a fixed 60 s window.
          headTimeMs: BigInt(f.expiration) - 60_000n,
        },
        timestampMs: BigInt(f.timestamp),
      });

    test(`${name}: raw_data is byte-identical to the captured one`, () => {
      expect(hex(build())).toBe(tx.raw_data_hex);
    });

    test(`${name}: txID is sha256 of the captured raw_data`, () => {
      expect(tronTxId(unhex(tx.raw_data_hex))).toBe(tx.txID);
    });

    test(`${name}: the txID signs to the captured signature (v = 27/28)`, async () => {
      const sig = await privateKeyTronAdapter(PK).signTronTransaction!(
        tx.txID,
        tx.raw_data_hex,
      );
      expect(sig).toBe(tx.signature);
      expect(sig.slice(-2)).toBe(tx.signature_v.slice(2));
    });
  }

  test("deposit_native carries call_value; settle omits a zero one", () => {
    // The two captured transactions differ in exactly this field's presence,
    // so a builder that always writes it (or never does) fails one of them
    // above. Here the reason is spelled out: TriggerSmartContract field 3
    // (varint, tag 0x18) appears only in the native deposit.
    expect(vectors.transactions.deposit_native.fields.call_value).toBe(
      10_000_000,
    );
    expect(vectors.transactions.settle.fields.call_value).toBe(0);
  });

  test("the timestamp defaults to now when not given", () => {
    const f = vectors.transactions.deposit_native.fields;
    const before = BigInt(Date.now());
    const raw = buildTriggerRawData({
      owner: f.owner_address_hex,
      contract: f.contract_address_hex,
      data: f.data as Hex,
      callValueSun: BigInt(f.call_value),
      feeLimitSun: BigInt(f.fee_limit),
      refBlock: {
        bytes: unhex(f.ref_block_bytes),
        hash: unhex(f.ref_block_hash),
        headTimeMs: BigInt(f.expiration) - 60_000n,
      },
    });
    expect(hex(raw)).not.toBe(vectors.transactions.deposit_native.raw_data_hex);
    // Read Transaction.raw field 14 (timestamp) back with the library's
    // reader and check it is "now".
    const reader = new BinaryReader(raw);
    let ms: bigint | undefined;
    while (reader.pos < reader.len) {
      const [field, wireType] = reader.tag();
      if (field === 14) ms = BigInt(reader.int64());
      else reader.skip(wireType);
    }
    expect(ms).toBeDefined();
    expect(ms! >= before && ms! <= BigInt(Date.now())).toBe(true);
  });

  test("refuses a T-form owner: the builder takes the venue's hex form", () => {
    const f = vectors.transactions.settle.fields;
    expect(() =>
      buildTriggerRawData({
        owner: f.owner_address_tron,
        contract: f.contract_address_hex,
        data: "0x",
        callValueSun: 0n,
        feeLimitSun: 1n,
        refBlock: {
          bytes: unhex(f.ref_block_bytes),
          hash: unhex(f.ref_block_hash),
          headTimeMs: 1n,
        },
      }),
    ).toThrow(/0x/);
  });

  test("refuses a reference block of the wrong shape", () => {
    const f = vectors.transactions.settle.fields;
    const base = {
      owner: f.owner_address_hex,
      contract: f.contract_address_hex,
      data: "0x" as Hex,
      callValueSun: 0n,
      feeLimitSun: 1n,
    };
    expect(() =>
      buildTriggerRawData({
        ...base,
        refBlock: {
          bytes: new Uint8Array(3),
          hash: new Uint8Array(8),
          headTimeMs: 1n,
        },
      }),
    ).toThrow(/2 bytes/);
    expect(() =>
      buildTriggerRawData({
        ...base,
        refBlock: {
          bytes: new Uint8Array(2),
          hash: new Uint8Array(7),
          headTimeMs: 1n,
        },
      }),
    ).toThrow(/8 bytes/);
  });

  test("refuses negative amounts", () => {
    const f = vectors.transactions.settle.fields;
    const refBlock = {
      bytes: unhex(f.ref_block_bytes),
      hash: unhex(f.ref_block_hash),
      headTimeMs: 1n,
    };
    const base = {
      owner: f.owner_address_hex,
      contract: f.contract_address_hex,
      data: "0x" as Hex,
      refBlock,
    };
    expect(() =>
      buildTriggerRawData({ ...base, callValueSun: -1n, feeLimitSun: 1n }),
    ).toThrow(/call value/);
    expect(() =>
      buildTriggerRawData({ ...base, callValueSun: 0n, feeLimitSun: -1n }),
    ).toThrow(/fee limit/);
  });
});

describe("tron vectors match the fixture: the TRON message digest", () => {
  test("Order text", () => {
    expect(tronMessageDigest(MSG.deterministic.text)).toBe(
      MSG.deterministic.digest,
    );
    expect(MSG.deterministic.text.length).toBe(456);
  });

  test("OrderToCancel text", () => {
    expect(tronMessageDigest(MSG.order_to_cancel.text)).toBe(
      MSG.order_to_cancel.digest,
    );
    expect(MSG.order_to_cancel.text.length).toBe(296);
  });

  test("withdraw text, signed as is", () => {
    expect(tronMessageDigest(MSG.withdraw.text)).toBe(MSG.withdraw.digest);
  });

  test("the MetaMask Tron capture's text", () => {
    expect(tronMessageDigest(MSG.wallet.text)).toBe(MSG.wallet.digest);
  });

  test("the length is the text's UTF-8 byte count, not its character count", () => {
    // Every fixture text is ASCII, where the two counts coincide. "é" is one
    // character and two bytes; the expected digest is keccak256 of the
    // literal preimage "\x19TRON Signed Message:\n2" ‖ c3 a9, computed
    // outside this module.
    expect(tronMessageDigest("é")).toBe(
      "0xf1f2c52d05eb3568377e8af8c979cf10f234f658b14e5a7e15012272faa78623",
    );
  });

  test("is not the Ethereum-prefixed digest of the same text", () => {
    expect(tronMessageDigest(MSG.deterministic.text)).not.toBe(
      MSG.deterministic.negative_ethereum_prefixed.digest,
    );
    expect(hashMessage(MSG.deterministic.text)).toBe(
      MSG.deterministic.negative_ethereum_prefixed.digest as Hex,
    );
  });
});

describe("TRON-prefixed signatures", () => {
  test("privateKeyTronAdapter matches fixture: Order, cancel and withdraw", async () => {
    const adapter = privateKeyTronAdapter(PK);
    expect(await adapter.signTronMessage!(MSG.deterministic.text)).toBe(
      MSG.deterministic.signature,
    );
    expect(await adapter.signTronMessage!(MSG.order_to_cancel.text)).toBe(
      MSG.order_to_cancel.signature,
    );
    expect(await adapter.signTronMessage!(MSG.withdraw.text)).toBe(
      MSG.withdraw.signature,
    );
  });

  test("same key, same message, both prefixes: each signature recovers only under its own", async () => {
    const text = MSG.deterministic.text;
    const tronSig = MSG.deterministic.signature as Hex;
    const ethSig = MSG.deterministic.negative_ethereum_prefixed
      .signature as Hex;
    const tronDigest = tronMessageDigest(text);
    const ethDigest = hashMessage(text);

    // Each under its own prefix recovers the one key.
    expect(
      (
        await recoverAddress({ hash: tronDigest, signature: tronSig })
      ).toLowerCase(),
    ).toBe(SIGNER);
    expect(
      (
        await recoverAddress({ hash: ethDigest, signature: ethSig })
      ).toLowerCase(),
    ).toBe(SIGNER);
    // Crossed, neither does.
    expect(
      (
        await recoverAddress({ hash: tronDigest, signature: ethSig })
      ).toLowerCase(),
    ).not.toBe(SIGNER);
    expect(
      (
        await recoverAddress({ hash: ethDigest, signature: tronSig })
      ).toLowerCase(),
    ).not.toBe(SIGNER);
    // And the adapter produces the TRON one, not the Ethereum one.
    const produced = await privateKeyTronAdapter(PK).signTronMessage!(text);
    expect(produced).toBe(tronSig);
    expect(produced).not.toBe(ethSig);
  });

  test("the binary form is not what a Tron leg signs", async () => {
    const neg = MSG.deterministic.negative_binary_form;
    expect(
      (
        await recoverAddress({
          hash: tronMessageDigest(MSG.deterministic.text),
          signature: neg.signature as Hex,
        })
      ).toLowerCase(),
    ).not.toBe(SIGNER);
    expect(tronMessageDigest(MSG.deterministic.text)).not.toBe(neg.digest);
  });

  test("the MetaMask Tron wallet capture verifies under the TRON digest", async () => {
    const recovered = await recoverAddress({
      hash: tronMessageDigest(MSG.wallet.text),
      signature: MSG.wallet.signature as Hex,
    });
    expect(recovered.toLowerCase()).toBe(MSG.wallet.account_hex);
  });

  test("privateKeyTronAdapter refuses EIP-191 signing", async () => {
    await expect(
      privateKeyTronAdapter(PK).signMessage("0x" + MSG.deterministic.text),
    ).rejects.toThrow(/TRON/);
  });

  test("signTronTransaction refuses a txID that is not sha256(raw_data)", async () => {
    const settle = vectors.transactions.settle;
    const other = vectors.transactions.deposit_native;
    await expect(
      privateKeyTronAdapter(PK).signTronTransaction!(
        other.txID,
        settle.raw_data_hex,
      ),
    ).rejects.toThrow(/txID/);
  });
});

describe("tronJsonRpcUrl", () => {
  test("appends /jsonrpc to the HTTP base, keeping a query-string key", () => {
    expect(tronJsonRpcUrl("https://api.trongrid.io")).toBe(
      "https://api.trongrid.io/jsonrpc",
    );
    expect(tronJsonRpcUrl("https://nile.trongrid.io/")).toBe(
      "https://nile.trongrid.io/jsonrpc",
    );
    expect(tronJsonRpcUrl("https://node.example/tron?apikey=abc")).toBe(
      "https://node.example/tron/jsonrpc?apikey=abc",
    );
  });
});
