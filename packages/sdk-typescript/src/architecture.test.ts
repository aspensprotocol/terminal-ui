import { describe, expect, test } from "bun:test";

import { isEvmAddressed, parseArchitecture } from "./architecture.js";

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
