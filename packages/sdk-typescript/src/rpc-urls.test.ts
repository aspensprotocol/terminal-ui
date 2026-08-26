import { describe, expect, it } from "bun:test";
import {
  MASKED_RPC_URL,
  isUsableRpcUrl,
  primaryEndpointUrl,
  resolveRpcUrl,
} from "./rpc-urls.js";

/** A chain with a single enabled endpoint at `url` — the common case. */
const chain = (network: string, url: string) => ({
  network,
  rpcs: [{ url, enabled: true }],
});

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

  // I-1: the arborter's mask now also sentinel-writes "***" into every
  // masked query value, userinfo, and non-empty path segment (not just the
  // whole-string legacy mask) — the detector must recognize all three
  // shapes, the same substring check infra's `redacted()` uses.
  it("rejects the current partial mask in every position it can appear", () => {
    expect(isUsableRpcUrl("https://rpc.example/v2?key=***")).toBe(false);
    expect(isUsableRpcUrl("https://***:***@rpc.example/v2")).toBe(false);
    expect(isUsableRpcUrl("https://rpc.example/***/***")).toBe(false);
  });

  // Anti-vacuity: a real, never-masked url must still pass, even one with
  // path segments and a query string — proving the check above rejects for
  // the reason it claims rather than rejecting everything with a path/query.
  it("still accepts a real url with a path and query string", () => {
    expect(isUsableRpcUrl("https://rpc.example/v2/abcdef123456?debug=1")).toBe(
      true,
    );
  });
});

describe("primaryEndpointUrl", () => {
  it("returns the first enabled endpoint's url", () => {
    expect(
      primaryEndpointUrl({
        rpcs: [
          { url: "https://primary.example/rpc", enabled: true },
          { url: "https://backup.example/rpc", enabled: true },
        ],
      }),
    ).toBe("https://primary.example/rpc");
  });

  it("skips a disabled leading endpoint", () => {
    expect(
      primaryEndpointUrl({
        rpcs: [
          { url: "https://disabled.example/rpc", enabled: false },
          { url: "https://enabled.example/rpc", enabled: true },
        ],
      }),
    ).toBe("https://enabled.example/rpc");
  });

  it("returns an empty string when no endpoint is enabled (or the set is empty)", () => {
    expect(
      primaryEndpointUrl({
        rpcs: [{ url: "https://disabled.example/rpc", enabled: false }],
      }),
    ).toBe("");
    expect(primaryEndpointUrl({ rpcs: [] })).toBe("");
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

  it("uses the first ENABLED config endpoint, skipping a disabled leading one", () => {
    const c = {
      network: "flare-coston2",
      rpcs: [
        { url: "https://disabled.example/rpc", enabled: false },
        { url: "https://from-config.example/rpc", enabled: true },
      ],
    };
    expect(resolveRpcUrl(c, undefined)).toBe("https://from-config.example/rpc");
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
