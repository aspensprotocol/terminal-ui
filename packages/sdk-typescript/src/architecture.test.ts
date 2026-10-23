import { describe, expect, test } from "bun:test";

import {
  givingArchitecture,
  isEvmAddressed,
  parseArchitecture,
} from "./architecture.js";

describe("parseArchitecture", () => {
  test("reads the three architectures in any case", () => {
    expect(parseArchitecture("EVM")).toBe("evm");
    expect(parseArchitecture("evm")).toBe("evm");
    expect(parseArchitecture("Solana")).toBe("solana");
    expect(parseArchitecture("SOLANA")).toBe("solana");
    expect(parseArchitecture("Tron")).toBe("tron");
    expect(parseArchitecture("TRON")).toBe("tron");
    expect(parseArchitecture("tron")).toBe("tron");
  });

  test("an empty architecture still means evm", () => {
    expect(parseArchitecture("")).toBe("evm");
  });

  test('parseArchitecture("sui") throws', () => {
    expect(() => parseArchitecture("sui")).toThrow(/sui/);
  });

  test("near misses are unknown, not defaulted", () => {
    expect(() => parseArchitecture("Hedera")).toThrow();
    expect(() => parseArchitecture(" evm")).toThrow();
    expect(() => parseArchitecture("tvm")).toThrow();
  });
});

describe("isEvmAddressed", () => {
  test("EVM and Tron carry 0x-hex 20-byte accounts; Solana does not", () => {
    expect(isEvmAddressed("evm")).toBe(true);
    expect(isEvmAddressed("tron")).toBe(true);
    expect(isEvmAddressed("solana")).toBe(false);
  });
});

describe("givingArchitecture", () => {
  // A cross-chain market whose two legs are on different architectures, so
  // a helper that read the wrong leg returns the other one.
  const market = {
    baseChainArchitecture: "Tron",
    quoteChainArchitecture: "EVM",
  };

  test("a BID gives quote: the quote chain's architecture", () => {
    expect(givingArchitecture(market, "buy")).toBe("evm");
  });

  test("an ASK gives base: the base chain's architecture", () => {
    expect(givingArchitecture(market, "sell")).toBe("tron");
  });

  test("the mirrored market flips both", () => {
    const mirrored = {
      baseChainArchitecture: "EVM",
      quoteChainArchitecture: "Tron",
    };
    expect(givingArchitecture(mirrored, "buy")).toBe("tron");
    expect(givingArchitecture(mirrored, "sell")).toBe("evm");
  });

  test("Solana legs are read the same way", () => {
    const m = {
      baseChainArchitecture: "Solana",
      quoteChainArchitecture: "EVM",
    };
    expect(givingArchitecture(m, "sell")).toBe("solana");
    expect(givingArchitecture(m, "buy")).toBe("evm");
  });

  test("an absent giving-leg architecture throws rather than meaning evm", () => {
    expect(() =>
      givingArchitecture({ baseChainArchitecture: "Tron" }, "buy"),
    ).toThrow(/quote/);
    expect(() =>
      givingArchitecture({ quoteChainArchitecture: "Tron" }, "sell"),
    ).toThrow(/base/);
  });

  test("an unknown giving-leg architecture throws", () => {
    expect(() =>
      givingArchitecture(
        { baseChainArchitecture: "sui", quoteChainArchitecture: "EVM" },
        "sell",
      ),
    ).toThrow(/sui/);
  });
});
