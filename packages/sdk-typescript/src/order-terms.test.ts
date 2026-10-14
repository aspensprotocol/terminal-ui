/**
 * Order-id verification and the terms block.
 *
 * Every expected id below was produced by Rust, never by the code under test:
 *
 * - the limit-bid vector is the arborter's own
 *   `order_id.rs::sdk_parity_known_good_vector`;
 * - the Solana and EVM-ask vectors were printed by the Rust SDK's
 *   `aspens::commands::trading::gasless::build_order_commitment` (sdk
 *   `9f5da21`), called from a throwaway binary with the fixture below, a
 *   Solana wallet built from the secret seed `[7u8; 32]`, and anvil account 0.
 *   The same binary reproduced the arborter vector first, which is what
 *   anchors its fixture to this one.
 *
 * The decimal scales are mutually distinct (pair 12, EVM base 18, SOL 9,
 * quote 6), and the quantity has digits below the 9-decimal scale, so a wrong
 * rescale or a missing floor changes the digest.
 */

import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";

import {
  decodeTermsBlock,
  encodeTermsBlock,
  TERMS_BLOCK_PREFIX,
  verifyOrderId,
  type OrderTerms,
} from "./order-terms.js";
import { orderIdPreimage } from "./order-commitment.js";
import { toMarkets } from "./adapters/config-adapter.js";
import { ConfigurationSchema } from "./protos/arborter_config_pb.js";

// -- fixture -------------------------------------------------------------

const EVM_BASE_NET = "fixture-base";
const EVM_QUOTE_NET = "fixture-quote";
const SOL_NET = "fixture-sol";
const EVM_BASE = "0x00000000000000000000000000000000000000b1";
const EVM_QUOTE = "0x00000000000000000000000000000000000000c1";
const SOL_MINT = "So11111111111111111111111111111111111111112";

/** anvil account 0, EIP-55 — the arborter vector's signer. */
const EVM_OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
/** The pubkey of the Solana keypair with secret seed `[7u8; 32]`. */
const SOL_OWNER = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";

const EVM_MARKET = `${EVM_BASE_NET}::${EVM_BASE}::${EVM_QUOTE_NET}::${EVM_QUOTE}`;
const SOL_BASE_MARKET = `${SOL_NET}::${SOL_MINT}::${EVM_QUOTE_NET}::${EVM_QUOTE}`;
const SOL_QUOTE_MARKET = `${EVM_BASE_NET}::${EVM_BASE}::${SOL_NET}::${SOL_MINT}`;

function market(
  marketId: string,
  baseNet: string,
  quoteNet: string,
  baseDecimals: number,
  quoteDecimals: number,
) {
  return {
    name: marketId,
    marketId,
    baseChainNetwork: baseNet,
    quoteChainNetwork: quoteNet,
    baseChainTokenDecimals: baseDecimals,
    quoteChainTokenDecimals: quoteDecimals,
    pairDecimals: 12,
  };
}

const config = create(ConfigurationSchema, {
  chains: [
    { network: EVM_BASE_NET, chainId: 990_001, architecture: "EVM" },
    { network: EVM_QUOTE_NET, chainId: 990_002, architecture: "EVM" },
    // Solana's chain id is 0 in the venue configuration.
    { network: SOL_NET, chainId: 0, architecture: "Solana" },
  ],
  markets: [
    market(EVM_MARKET, EVM_BASE_NET, EVM_QUOTE_NET, 18, 6),
    market(SOL_BASE_MARKET, SOL_NET, EVM_QUOTE_NET, 9, 6),
    market(SOL_QUOTE_MARKET, EVM_BASE_NET, SOL_NET, 18, 9),
  ],
});

/** The arborter's known-good limit bid. */
const ARBORTER_BID: OrderTerms = {
  market_id: EVM_MARKET,
  side: "BID",
  qty: "1500000000000",
  price: "2000000000000",
  nonce: "1723000000000",
  owner: EVM_OWNER,
  id: "0xc6d8846de54b5b1b2513fa5fb8b535ea48bbe2835c17187e6564443aaa774f2d",
};

/** Rust-SDK vectors: 2.500000000123 base at 1.75. */
const RUST_QTY = "2500000000123";
const RUST_PRICE = "1750000000000";
const RUST_NONCE = "1760000000000";

const SOLANA_ASK: OrderTerms = {
  market_id: SOL_BASE_MARKET,
  side: "ASK",
  qty: RUST_QTY,
  price: RUST_PRICE,
  nonce: RUST_NONCE,
  owner: SOL_OWNER,
  id: "0x35f097e4ec1a473c75300249562e926393593131ae346727860f90b59c46fa8e",
};

const SOLANA_BID: OrderTerms = {
  market_id: SOL_QUOTE_MARKET,
  side: "BID",
  qty: RUST_QTY,
  price: RUST_PRICE,
  nonce: RUST_NONCE,
  owner: SOL_OWNER,
  id: "0xfcc1f47a1ac043f7fa5eed8fe3da14ea5fa5fda324cc989703f4ded6b6295f50",
};

const EVM_ASK: OrderTerms = {
  market_id: EVM_MARKET,
  side: "ASK",
  qty: RUST_QTY,
  price: RUST_PRICE,
  nonce: RUST_NONCE,
  owner: EVM_OWNER,
  id: "0x9086e3f1524964d3ad7790982bf26756edd9486af29e16fafbba21330fc42a4f",
};

// -- verifyOrderId -------------------------------------------------------

describe("verifyOrderId against Rust-produced vectors", () => {
  for (const [name, terms] of [
    ["arborter limit bid (EVM)", ARBORTER_BID],
    ["EVM ask", EVM_ASK],
    ["Solana ask (owner on the Solana base chain)", SOLANA_ASK],
    ["Solana bid (owner on the Solana quote chain)", SOLANA_BID],
  ] as const) {
    test(name, () => {
      expect(verifyOrderId(terms, config)).toEqual({
        ok: true,
        orderId: terms.id,
      });
    });
  }

  test("the owner's EVM address case does not matter, the id's does", () => {
    expect(
      verifyOrderId({ ...ARBORTER_BID, owner: EVM_OWNER.toLowerCase() }, config)
        .ok,
    ).toBe(true);
    // An id that differs from the canonical rendering only in case is refused:
    // the comparison is exact, and decoding refuses it before that.
    const upper = `0x${ARBORTER_BID.id.slice(2).toUpperCase()}`;
    expect(verifyOrderId({ ...ARBORTER_BID, id: upper }, config).ok).toBe(
      false,
    );
  });
});

describe("verifyOrderId refuses tampered terms", () => {
  // Each tamper keeps the terms well formed, so only the recomputed id can
  // catch it — and the reported `expected` must differ from the stated id.
  // Every amount change is large enough to survive the floor into native
  // units (see the next block for one that is not).
  const tampers: [string, OrderTerms, Partial<OrderTerms>][] = [
    // 1.5 base -> 1.500001 base: +1e12 wei of base, +2 units of 6-dp quote.
    ["qty", ARBORTER_BID, { qty: "1500001000000" }],
    // 2.0 -> 2.000001: +1.5e-6 quote over 1.5 base, one 6-dp unit.
    ["price", ARBORTER_BID, { price: "2000001000000" }],
    ["nonce", ARBORTER_BID, { nonce: "1723000000001" }],
    [
      "owner",
      ARBORTER_BID,
      { owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
    ],
    ["side", ARBORTER_BID, { side: "ASK" }],
    // Same lock chain (EVM base) and signer, different quote chain and token.
    ["market", EVM_ASK, { market_id: SOL_QUOTE_MARKET }],
    // Another valid Solana pubkey as the owner.
    ["Solana owner", SOLANA_ASK, { owner: SOL_MINT }],
    ["Solana qty", SOLANA_ASK, { qty: "2500001000000" }],
    ["Solana price", SOLANA_BID, { price: "1750001000000" }],
    ["Solana nonce", SOLANA_BID, { nonce: "1760000000001" }],
  ];
  for (const [name, base, change] of tampers) {
    test(name, () => {
      const result = verifyOrderId({ ...base, ...change }, config);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/not the id these terms derive/);
        expect(result.expected).toMatch(/^0x[0-9a-f]{64}$/);
        expect(result.expected).not.toBe(base.id);
      }
    });
  }

  test("a side flip that moves the lock to the other chain's architecture is refused", () => {
    // An ASK on the Solana-base market locks on Solana; as a BID it would lock
    // on the EVM quote chain, where a base58 owner is not an address.
    const result = verifyOrderId({ ...SOLANA_ASK, side: "BID" }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cannot be an EVM address/);
  });
});

describe("what the id does not commit", () => {
  // The id hashes NATIVE-unit amounts, floored from pair units. Terms that
  // differ only below both tokens' precision derive the same id, so they
  // verify. The economic difference is under one native unit on each leg —
  // but the stated pair-unit qty/price are not proven digit for digit.
  test("a qty change below the base token's precision verifies", () => {
    // 2.500000000123 and 2.500000000999 floor to the same 9-dp SOL amount,
    // and qty x price floors to the same 6-dp quote amount.
    expect(
      verifyOrderId({ ...SOLANA_ASK, qty: "2500000000999" }, config).ok,
    ).toBe(true);
  });

  test("a price change below the quote token's precision verifies", () => {
    // 1.5 x 2.000000000001 = 3.0000000000015 quote, floored to 3.000000.
    expect(
      verifyOrderId({ ...ARBORTER_BID, price: "2000000000001" }, config).ok,
    ).toBe(true);
  });
});

describe("verifyOrderId refuses unusable terms", () => {
  test("an unknown market is refused without hashing", () => {
    const result = verifyOrderId(
      { ...ARBORTER_BID, market_id: "nowhere::0x1::nowhere::0x2" },
      config,
    );
    expect(result).toEqual({
      ok: false,
      reason:
        "market 'nowhere::0x1::nowhere::0x2' is not in the venue configuration",
    });
  });

  test("an owner that is not an address of the lock chain is refused, not thrown", () => {
    // An EVM address where the lock chain is Solana: not base58 of 32 bytes.
    const result = verifyOrderId({ ...SOLANA_ASK, owner: EVM_OWNER }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/cannot be hashed/);
      expect(result.expected).toBeUndefined();
    }
  });

  test("malformed terms are refused before hashing", () => {
    const result = verifyOrderId({ ...ARBORTER_BID, qty: "1.5" }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/qty must be/);
  });
});

describe("orderIdPreimage", () => {
  test("is the exact concatenation the id hashes, field by field", () => {
    const [m] = toMarkets(config).filter((x) => x.id === SOL_BASE_MARKET);
    const bytes = orderIdPreimage({
      market: m!,
      config,
      side: "sell",
      userAddress: SOL_OWNER,
      quantityRaw: RUST_QTY,
      priceRaw: RUST_PRICE,
      nonce: BigInt(RUST_NONCE),
    });
    const sol = new TextEncoder().encode(SOL_MINT);
    const quote = new TextEncoder().encode(EVM_QUOTE);
    // user 32 | nonce 8 | origin 8 | dest 8 | input token | output token | 16 | 16
    expect(bytes.length).toBe(32 + 8 + 8 + 8 + sol.length + quote.length + 32);

    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getBigUint64(32, true)).toBe(BigInt(RUST_NONCE));
    // An ASK originates on the base chain — Solana, chain id 0 — and is
    // destined for the quote chain.
    expect(view.getBigUint64(40, true)).toBe(0n);
    expect(view.getBigUint64(48, true)).toBe(990_002n);
    const tokens = new TextDecoder().decode(
      bytes.slice(56, 56 + sol.length + quote.length),
    );
    expect(tokens).toBe(SOL_MINT + EVM_QUOTE);
    const amounts = 56 + sol.length + quote.length;
    // Input: qty from pair (12) to SOL (9) decimals, floored.
    expect(view.getBigUint64(amounts, true)).toBe(2_500_000_000n);
    expect(view.getBigUint64(amounts + 8, true)).toBe(0n);
    // Output: qty x price from 24 to 6 decimals, floored: 4.375000 quote.
    expect(view.getBigUint64(amounts + 16, true)).toBe(4_375_000n);
  });
});

// -- terms block ---------------------------------------------------------

/** Wrap an arbitrary JSON payload the way an encoder would. */
function block(payload: unknown): string {
  const json = typeof payload === "string" ? payload : JSON.stringify(payload);
  return (
    TERMS_BLOCK_PREFIX +
    btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  );
}

describe("terms block round trip", () => {
  test("encode then decode returns the same terms", () => {
    for (const terms of [ARBORTER_BID, SOLANA_ASK, SOLANA_BID]) {
      expect(decodeTermsBlock(encodeTermsBlock(terms))).toEqual(terms);
    }
  });

  test("the line is the prefix plus unpadded base64url of the JSON in key order", () => {
    const line = encodeTermsBlock(ARBORTER_BID);
    expect(line.startsWith("aspens-otc:v1:")).toBe(true);
    const payload = line.slice("aspens-otc:v1:".length);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    expect(Object.keys(JSON.parse(json))).toEqual([
      "market_id",
      "side",
      "qty",
      "price",
      "nonce",
      "owner",
      "id",
    ]);
  });

  test("a payload whose base64 needs '-' and '_' decodes", () => {
    // '?>' and '~' push the standard alphabet onto '+' and '/'.
    const terms = { ...ARBORTER_BID, owner: "??>>~~" };
    const line = encodeTermsBlock(terms);
    expect(line).toMatch(/[-_]/);
    expect(decodeTermsBlock(line)).toEqual(terms);
  });

  test("surrounding whitespace from a paste is ignored", () => {
    expect(decodeTermsBlock(`  ${encodeTermsBlock(ARBORTER_BID)}\n`)).toEqual(
      ARBORTER_BID,
    );
  });

  test("encode refuses terms that decode would refuse", () => {
    expect(() => encodeTermsBlock({ ...ARBORTER_BID, nonce: "-1" })).toThrow(
      /nonce must be/,
    );
  });
});

describe("decodeTermsBlock refuses", () => {
  const good = { ...ARBORTER_BID } as Record<string, unknown>;

  test("a valid hand-built block decodes (the fixture is sound)", () => {
    expect(decodeTermsBlock(block(good))).toEqual(ARBORTER_BID);
  });

  test("a different prefix", () => {
    expect(() => decodeTermsBlock("hello world")).toThrow(/not a terms block/);
  });

  test("a different version", () => {
    const line = block(good).replace("aspens-otc:v1:", "aspens-otc:v2:");
    expect(() => decodeTermsBlock(line)).toThrow(/version 'v2'/);
  });

  test("standard-alphabet or padded base64", () => {
    expect(() => decodeTermsBlock(`${TERMS_BLOCK_PREFIX}ab+c`)).toThrow(
      /not base64url/,
    );
    expect(() => decodeTermsBlock(`${TERMS_BLOCK_PREFIX}ab/c`)).toThrow(
      /not base64url/,
    );
    expect(() => decodeTermsBlock(`${TERMS_BLOCK_PREFIX}YQ==`)).toThrow(
      /not base64url/,
    );
  });

  test("an empty or truncated payload", () => {
    expect(() => decodeTermsBlock(TERMS_BLOCK_PREFIX)).toThrow(/not base64url/);
    expect(() => decodeTermsBlock(`${TERMS_BLOCK_PREFIX}abcde`)).toThrow(
      /truncated/,
    );
  });

  test("bytes that are not UTF-8", () => {
    // 0xff 0xfe is valid base64url ('__4') but never valid UTF-8.
    expect(() => decodeTermsBlock(`${TERMS_BLOCK_PREFIX}__4`)).toThrow(
      /not UTF-8/,
    );
  });

  test("a payload that is not JSON, or not an object", () => {
    expect(() => decodeTermsBlock(block("{not json"))).toThrow(/not JSON/);
    expect(() => decodeTermsBlock(block([1, 2]))).toThrow(/not a JSON object/);
    expect(() => decodeTermsBlock(block("null"))).toThrow(/not a JSON object/);
  });

  for (const key of [
    "market_id",
    "side",
    "qty",
    "price",
    "nonce",
    "owner",
    "id",
  ]) {
    test(`a missing '${key}'`, () => {
      const { [key]: _drop, ...rest } = good;
      expect(() => decodeTermsBlock(block(rest))).toThrow(
        new RegExp(`missing '${key}'`),
      );
    });
  }

  test("an unknown field", () => {
    expect(() => decodeTermsBlock(block({ ...good, extra: "x" }))).toThrow(
      /unknown field 'extra'/,
    );
  });

  test("a number where a decimal string belongs", () => {
    // A JSON number would round anything above 2^53.
    for (const key of ["qty", "price", "nonce"]) {
      expect(() =>
        decodeTermsBlock(block({ ...good, [key]: 1500000000000 })),
      ).toThrow(new RegExp(`'${key}' is not a string`));
    }
  });

  test("a side other than BID or ASK", () => {
    for (const side of ["bid", "BUY", ""]) {
      expect(() => decodeTermsBlock(block({ ...good, side }))).toThrow(
        /side must be/,
      );
    }
  });

  for (const key of ["qty", "price", "nonce"]) {
    test(`a ${key} that is not a canonical decimal integer`, () => {
      for (const bad of ["1.5", "-1", "+1", "1e3", "0x10", "01", " 1", ""]) {
        expect(() => decodeTermsBlock(block({ ...good, [key]: bad }))).toThrow(
          new RegExp(`${key} must be a decimal integer`),
        );
      }
    });
  }

  test("a nonce beyond uint64", () => {
    expect(() =>
      decodeTermsBlock(block({ ...good, nonce: (1n << 64n).toString() })),
    ).toThrow(/not a uint64/);
    // The ceiling itself is fine.
    expect(
      decodeTermsBlock(block({ ...good, nonce: ((1n << 64n) - 1n).toString() }))
        .nonce,
    ).toBe("18446744073709551615");
  });

  test("an id that is not 0x plus 64 lowercase hex digits", () => {
    const hex = ARBORTER_BID.id.slice(2);
    for (const id of [
      hex, // no prefix
      `0x${hex.slice(2)}`, // 62 digits
      `0x${hex}00`, // 66 digits
      `0x${hex.toUpperCase()}`, // upper case
      `0x${hex.slice(0, 63)}g`, // not hex
    ]) {
      expect(() => decodeTermsBlock(block({ ...good, id }))).toThrow(
        /id must be 0x/,
      );
    }
  });

  test("an empty market_id or owner", () => {
    expect(() => decodeTermsBlock(block({ ...good, market_id: "" }))).toThrow(
      /market_id is empty/,
    );
    expect(() => decodeTermsBlock(block({ ...good, owner: "" }))).toThrow(
      /owner is empty/,
    );
  });
});
