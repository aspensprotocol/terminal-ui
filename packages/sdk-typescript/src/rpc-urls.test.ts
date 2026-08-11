import { describe, expect, it } from "bun:test";
import { MASKED_RPC_URL, isUsableRpcUrl, resolveRpcUrl } from "./rpc-urls.js";

const chain = (network: string, rpcUrl: string) =>
  ({ network, rpcUrl }) as Parameters<typeof resolveRpcUrl>[0];

describe("isUsableRpcUrl", () => {
  it("rejects the arborter's mask", () => {
    // GetConfig replaces every non-empty rpc_url with this fixed run of '*'
    // (arborter config_service/crud.rs RPC_URL_MASK).
    expect(isUsableRpcUrl(MASKED_RPC_URL)).toBe(false);
  });

  it("rejects empty / whitespace / any all-asterisk run", () => {
    expect(isUsableRpcUrl("")).toBe(false);
    expect(isUsableRpcUrl("   ")).toBe(false);
    expect(isUsableRpcUrl("****")).toBe(false);
    expect(isUsableRpcUrl("****************")).toBe(false);
  });

  it("rejects non-http(s) schemes and scheme-less values", () => {
    expect(isUsableRpcUrl("ftp://example.com")).toBe(false);
    expect(isUsableRpcUrl("example.com/rpc")).toBe(false);
  });

  it("accepts real http(s) endpoints", () => {
    expect(isUsableRpcUrl("https://coston2-api.flare.network/ext/C/rpc")).toBe(
      true,
    );
    expect(isUsableRpcUrl("http://localhost:8545")).toBe(true);
  });
});

describe("resolveRpcUrl", () => {
  it("prefers an override keyed by chain network", () => {
    const c = chain("flare-coston2", "https://from-config.example/rpc");
    expect(
      resolveRpcUrl(c, { "flare-coston2": "https://override.example/rpc" }),
    ).toBe("https://override.example/rpc");
  });

  it("uses the config url when no override is supplied", () => {
    const c = chain("flare-coston2", "https://from-config.example/rpc");
    expect(resolveRpcUrl(c, undefined)).toBe("https://from-config.example/rpc");
    expect(resolveRpcUrl(c, {})).toBe("https://from-config.example/rpc");
  });

  it("returns null when the config url is masked and no override exists", () => {
    // The regression this module exists for: a masked url used to reach viem
    // verbatim, every read threw, and each throw was caught into 0n — the
    // balances panel showed zeros indistinguishable from 'no deposits'.
    const c = chain("flare-coston2", MASKED_RPC_URL);
    expect(resolveRpcUrl(c, undefined)).toBeNull();
  });

  it("lets an override rescue a masked config url", () => {
    const c = chain("flare-coston2", MASKED_RPC_URL);
    expect(
      resolveRpcUrl(c, { "flare-coston2": "https://override.example/rpc" }),
    ).toBe("https://override.example/rpc");
  });

  it("ignores an unusable override rather than dialing it", () => {
    const c = chain("flare-coston2", "https://from-config.example/rpc");
    expect(resolveRpcUrl(c, { "flare-coston2": "  " })).toBe(
      "https://from-config.example/rpc",
    );
  });

  it("does not apply another chain's override", () => {
    const c = chain("hyperevm-testnet", MASKED_RPC_URL);
    expect(
      resolveRpcUrl(c, { "flare-coston2": "https://override.example/rpc" }),
    ).toBeNull();
  });
});

describe("parseRpcUrlMap", () => {
  it("parses a JSON object of network -> url", async () => {
    const { parseRpcUrlMap } = await import("./rpc-urls.js");
    expect(parseRpcUrlMap('{"flare-coston2":"https://a.example/rpc"}')).toEqual(
      { "flare-coston2": "https://a.example/rpc" },
    );
  });

  it("returns an empty map for empty / malformed input", async () => {
    const { parseRpcUrlMap } = await import("./rpc-urls.js");
    expect(parseRpcUrlMap(undefined)).toEqual({});
    expect(parseRpcUrlMap("")).toEqual({});
    expect(parseRpcUrlMap("not json")).toEqual({});
    expect(parseRpcUrlMap('["array"]')).toEqual({});
  });

  it("drops entries whose value is not a usable url", async () => {
    const { parseRpcUrlMap } = await import("./rpc-urls.js");
    expect(
      parseRpcUrlMap(
        '{"a":"https://ok.example/rpc","b":"********","c":123,"d":""}',
      ),
    ).toEqual({ a: "https://ok.example/rpc" });
  });
});
