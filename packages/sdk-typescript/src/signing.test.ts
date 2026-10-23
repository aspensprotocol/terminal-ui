/**
 * Parity tests for the wallet-signature normalization layer.
 *
 * Arborter requires curve-native signature lengths with no tolerance:
 * exactly 65 bytes for Secp256k1 (EVM, `r||s||v`) and exactly 64 bytes
 * for Ed25519 (Solana, `r||s`). EVM wallets return 65 bytes and Solana
 * wallets return 64 bytes; both pass through unchanged. This regression
 * suite pins both paths so a refactor can't silently corrupt one of them
 * (e.g. by slicing the EVM signature to 64 bytes).
 */

import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { hashMessage, recoverAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import vectors from "./tron-vectors.json";
import {
  createOrderMessage,
  normalizeWalletSignature,
  privateKeyTronAdapter,
  serializeOrder,
  signCancelOrder,
  signOrder,
  type CancelSigningData,
  type OrderSigningData,
  type SigningAdapter,
} from "./signing.js";
import { tronMessageDigest } from "./tron.js";
import { givingArchitecture } from "./architecture.js";
import { OrderToCancelSchema, Side } from "./protos/arborter_pb";

describe("normalizeWalletSignature", () => {
  test("passes a 65-byte EVM ECDSA signature through unchanged", () => {
    // r[32] || s[32] || v[1] — the EVM wire format from wagmi/viem/ethers,
    // and the exact wire format arborter's Secp256k1 verifier requires.
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    const v = new Uint8Array([0x1c]); // recovery byte (27 / 28 canonical)
    const sig = new Uint8Array([...r, ...s, ...v]);

    const out = normalizeWalletSignature(sig);

    expect(out.length).toBe(65);
    expect(out).toEqual(sig);
    expect(out.slice(0, 32)).toEqual(r);
    expect(out.slice(32, 64)).toEqual(s);
    expect(out.slice(64, 65)).toEqual(v);
  });

  test("passes a 64-byte Solana Ed25519 signature through unchanged", () => {
    // Ed25519 signatures produced by @solana/wallet-adapter are already
    // 64 bytes (r||s). Any slicing would corrupt them.
    const sig = new Uint8Array(64).fill(0xab);

    const out = normalizeWalletSignature(sig);

    expect(out.length).toBe(64);
    expect(out).toEqual(sig);
    // Same reference semantics aren't required, but value equality is.
  });

  test("throws on an unexpected signature length", () => {
    // A wallet adapter returning something this code doesn't understand
    // must fail loudly rather than ship a bogus signature that the
    // arborter would silently reject.
    const tooShort = new Uint8Array(63);
    const tooLong = new Uint8Array(66);
    const way_off = new Uint8Array(32); // e.g. a hash, not a signature

    expect(() => normalizeWalletSignature(tooShort)).toThrow(/length 63/);
    expect(() => normalizeWalletSignature(tooLong)).toThrow(/length 66/);
    expect(() => normalizeWalletSignature(way_off)).toThrow(/length 32/);
  });
});

describe("OrderToCancel wire encoding", () => {
  test("is {market_id=1, side=2, order_id=3} — same bytes the arborter and sdk pin", () => {
    const msg = create(OrderToCancelSchema, {
      marketId: "a::0x1::b::0x2",
      side: Side.ASK,
      orderId: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
    });
    const bytes = toBinary(OrderToCancelSchema, msg);
    const expected = new Uint8Array([
      0x0a,
      14,
      ...new TextEncoder().encode("a::0x1::b::0x2"),
      0x10,
      0x02,
      0x1a,
      32,
      ...Array.from({ length: 32 }, (_, i) => i + 1),
    ]);
    expect(bytes).toEqual(expected);
  });
});

// -- per-architecture signing ---------------------------------------------

const PK = vectors.test_only_private_key.private_key as Hex;
const SIGNER = vectors.test_only_private_key.address_hex;
const V2 = vectors.sign_message_v2;

/** The fixture's deterministic Order, as the SDK's signing input. */
const FIXTURE_ORDER: OrderSigningData = {
  side: "sell", // SIDE_ASK
  quantity: V2.deterministic.message.fields.quantity,
  price: V2.deterministic.message.fields.price,
  marketId: V2.deterministic.message.fields.market_id,
  baseAccountAddress: V2.deterministic.message.fields.base_account_address,
  quoteAccountAddress: V2.deterministic.message.fields.quote_account_address,
  nonce: BigInt(V2.deterministic.message.fields.nonce),
  session: BigInt(V2.deterministic.message.fields.session),
};

const FIXTURE_CANCEL: CancelSigningData = {
  marketId: V2.order_to_cancel.message.fields.market_id,
  side: "sell", // SIDE_ASK
  orderId: V2.order_to_cancel.message.fields.order_id,
};

function toHex(b: Uint8Array): Hex {
  return ("0x" +
    Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("")) as Hex;
}

/** An adapter whose every method records its argument; Tron signing is
 * delegated to the private-key adapter so signatures are real. */
function recordingAdapter(opts: { tron: boolean }) {
  const calls: { method: string; arg: unknown }[] = [];
  const inner = privateKeyTronAdapter(PK);
  const evm = privateKeyToAccount(PK);
  const adapter: SigningAdapter = {
    async signMessage(hexMessage: string) {
      calls.push({ method: "signMessage", arg: hexMessage });
      return evm.signMessage({ message: { raw: hexMessage as Hex } });
    },
    async signBytes(bytes: Uint8Array) {
      calls.push({ method: "signBytes", arg: bytes });
      throw new Error("signBytes must not be called");
    },
  };
  if (opts.tron) {
    adapter.signTronMessage = async (text: string) => {
      calls.push({ method: "signTronMessage", arg: text });
      return inner.signTronMessage!(text);
    };
  }
  return { adapter, calls };
}

describe("Order encoding parity with the arborter's prost", () => {
  test("createOrderMessage reproduces the fixture's Order bytes", () => {
    expect(toHex(serializeOrder(createOrderMessage(FIXTURE_ORDER)))).toBe(
      V2.deterministic.message.bytes_hex as Hex,
    );
  });
});

describe("signOrder on a tron leg", () => {
  test("signOrder on a tron leg uses signTronMessage", async () => {
    const { adapter, calls } = recordingAdapter({ tron: true });
    const sig = await signOrder(FIXTURE_ORDER, adapter, "Tron");

    expect(toHex(sig)).toBe(V2.deterministic.signature as Hex);
    expect(calls.map((c) => c.method)).toEqual(["signTronMessage"]);
    // Recovers under the TRON prefix to the key, and not under EIP-191
    // (neither over the text nor over the raw bytes, which is what an EVM
    // leg signs).
    const recover = async (hash: Hex) =>
      (await recoverAddress({ hash, signature: toHex(sig) })).toLowerCase();
    expect(await recover(tronMessageDigest(V2.deterministic.text))).toBe(
      SIGNER,
    );
    expect(await recover(hashMessage(V2.deterministic.text))).not.toBe(SIGNER);
    expect(
      await recover(
        hashMessage({ raw: V2.deterministic.message.bytes_hex as Hex }),
      ),
    ).not.toBe(SIGNER);
  });

  test("hands the adapter the lowercase hex text, never binary", async () => {
    const { adapter, calls } = recordingAdapter({ tron: true });
    await signOrder(FIXTURE_ORDER, adapter, "tron");

    expect(calls).toHaveLength(1);
    const arg = calls[0]!.arg;
    expect(typeof arg).toBe("string");
    expect(arg).toBe(V2.deterministic.text);
    expect(arg as string).toMatch(/^[0-9a-f]+$/);
    expect((arg as string).length).toBe(456);
    expect((arg as string).startsWith("0x")).toBe(false);
  });

  test("signOrder on a tron leg throws without signTronMessage", async () => {
    const { adapter, calls } = recordingAdapter({ tron: false });
    await expect(signOrder(FIXTURE_ORDER, adapter, "tron")).rejects.toThrow(
      /signTronMessage/,
    );
    // It did not fall back to the EIP-191 signer.
    expect(calls).toEqual([]);
  });

  test("a Tron leg refuses a signature that is not 65 bytes", async () => {
    const adapter: SigningAdapter = {
      signMessage: async () => "0x00",
      signTronMessage: async () => "0x" + "ab".repeat(64),
    };
    await expect(signOrder(FIXTURE_ORDER, adapter, "tron")).rejects.toThrow(
      /65/,
    );
  });

  test("signCancelOrder on a tron leg signs the cancel text", async () => {
    const { adapter, calls } = recordingAdapter({ tron: true });
    const sig = await signCancelOrder(FIXTURE_CANCEL, adapter, "tron");

    expect(toHex(sig)).toBe(V2.order_to_cancel.signature as Hex);
    expect(calls).toEqual([
      { method: "signTronMessage", arg: V2.order_to_cancel.text },
    ]);
  });

  test("signCancelOrder on a tron leg throws without signTronMessage", async () => {
    const { adapter, calls } = recordingAdapter({ tron: false });
    await expect(
      signCancelOrder(FIXTURE_CANCEL, adapter, "tron"),
    ).rejects.toThrow(/signTronMessage/);
    expect(calls).toEqual([]);
  });
});

describe("signOrder on evm and solana legs is unchanged", () => {
  test("an EVM leg signs the 0x-hex bytes with signMessage, never the TRON prefix", async () => {
    const { adapter, calls } = recordingAdapter({ tron: true });
    const sig = await signOrder(FIXTURE_ORDER, adapter, "EVM");

    expect(calls).toEqual([
      { method: "signMessage", arg: V2.deterministic.message.bytes_hex },
    ]);
    const recovered = await recoverAddress({
      hash: hashMessage({ raw: V2.deterministic.message.bytes_hex as Hex }),
      signature: toHex(sig),
    });
    expect(recovered.toLowerCase()).toBe(SIGNER);
    expect(toHex(sig)).not.toBe(V2.deterministic.signature as Hex);
  });

  test("an empty architecture is an EVM leg", async () => {
    const { adapter, calls } = recordingAdapter({ tron: true });
    await signOrder(FIXTURE_ORDER, adapter, "");
    expect(calls.map((c) => c.method)).toEqual(["signMessage"]);
  });

  test("a Solana leg goes through signMessage with the 0x-hex bytes", async () => {
    const calls: string[] = [];
    const adapter: SigningAdapter = {
      async signMessage(hexMessage: string) {
        calls.push(hexMessage);
        return "0x" + "11".repeat(64);
      },
      signTronMessage: async () => {
        throw new Error("must not be called");
      },
    };
    const sig = await signOrder(FIXTURE_ORDER, adapter, "Solana");
    expect(sig.length).toBe(64);
    expect(calls).toEqual([V2.deterministic.message.bytes_hex]);
  });

  test("an unknown architecture is refused before anything is signed", async () => {
    const { adapter, calls } = recordingAdapter({ tron: true });
    await expect(signOrder(FIXTURE_ORDER, adapter, "sui")).rejects.toThrow(
      /sui/,
    );
    await expect(
      signCancelOrder(FIXTURE_CANCEL, adapter, "sui"),
    ).rejects.toThrow(/sui/);
    expect(calls).toEqual([]);
  });
});

describe("a cancel of a Tron-giving order", () => {
  test("never reaches EIP-191, even when the connected wallet is EVM", async () => {
    // A buy on an EVM-base / Tron-quote market gives quote: the Tron leg.
    // The wallet that holds the 0x account is an EVM wallet (the same 20
    // bytes), whose adapter has only signMessage.
    const market = {
      baseChainArchitecture: "EVM",
      quoteChainArchitecture: "Tron",
    };
    const calls: string[] = [];
    const evmWallet: SigningAdapter = {
      async signMessage(hexMessage: string) {
        calls.push(hexMessage);
        return "0x" + "11".repeat(65);
      },
    };
    await expect(
      signCancelOrder(
        { ...FIXTURE_CANCEL, side: "buy" },
        evmWallet,
        givingArchitecture(market, "buy"),
      ),
    ).rejects.toThrow(/signTronMessage/);
    expect(calls).toEqual([]);
  });
});
