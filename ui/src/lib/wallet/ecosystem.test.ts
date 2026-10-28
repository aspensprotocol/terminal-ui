/**
 * `Chain.architecture` → wallet ecosystem is a closed match: each known
 * architecture maps to its own ecosystem, and an unknown one throws instead
 * of quietly taking another chain's signing path. A Tron chain read as EVM
 * would sign its orders under the Ethereum message prefix, which the venue
 * refuses on a Tron leg.
 */

import { describe, expect, test } from "bun:test";
import type { Market } from "@aspensprotocol/sdk-ts";
import { architectureToEcosystem, sideLegs } from "./ecosystem";

describe("architectureToEcosystem", () => {
  test("tron maps to tron, not evm", () => {
    expect(architectureToEcosystem("tron")).toBe("tron");
    expect(architectureToEcosystem("Tron")).toBe("tron");
    expect(architectureToEcosystem("TRON")).toBe("tron");
  });

  test("evm and solana keep their own ecosystems", () => {
    expect(architectureToEcosystem("EVM")).toBe("evm");
    expect(architectureToEcosystem("Solana")).toBe("solana");
  });

  test("the proto default (empty) is evm", () => {
    expect(architectureToEcosystem("")).toBe("evm");
  });

  test("an unknown architecture throws rather than returning a wallet", () => {
    expect(() => architectureToEcosystem("sui")).toThrow(/sui/);
    expect(() => architectureToEcosystem("Hedera")).toThrow(/Hedera/);
  });

  test("a chain whose architecture is not joined yet has no ecosystem", () => {
    expect(architectureToEcosystem(undefined)).toBeNull();
  });
});

describe("sideLegs on a Tron/EVM market", () => {
  const market = {
    baseChainArchitecture: "Tron",
    quoteChainArchitecture: "EVM",
  } as Market;

  test("a sell gives the Tron base leg, so a Tron wallet signs it", () => {
    const legs = sideLegs(market, "sell");
    expect(legs.signingEcosystem).toBe("tron");
    expect(legs.receivingEcosystem).toBe("evm");
  });

  test("a buy gives the EVM quote leg and receives on Tron", () => {
    const legs = sideLegs(market, "buy");
    expect(legs.signingEcosystem).toBe("evm");
    expect(legs.receivingEcosystem).toBe("tron");
  });
});
