/**
 * GET_CONFIG envelope + protobuf decoding.
 *
 * The adapter relays the arborter's `GetConfigResponse` as OPAQUE protobuf
 * bytes, hex on the wire, rather than a JSON mirror of the config schema. These
 * pin the decode against the SAME generated type the gRPC path returns, so both
 * transports yield an identical `Configuration`. The Rust mirror of this suite
 * is `sdk/aspens/src/fce/payloads.rs` `config_tests`.
 */

import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { bytesToHex } from "viem";
import {
  ChainSchema,
  ConfigurationSchema,
  GetConfigResponseSchema,
} from "../protos/arborter_config_pb.js";
import { decodeConfigEnvelope } from "./config.js";

function envelopeFor(bytes: Uint8Array) {
  return { configProto: bytesToHex(bytes) };
}

describe("decodeConfigEnvelope", () => {
  test("round-trips into the generated Configuration", () => {
    const original = create(GetConfigResponseSchema, {
      config: create(ConfigurationSchema, {
        chains: [],
        markets: [],
      }),
    });
    const wire = toBinary(GetConfigResponseSchema, original);

    const decoded = decodeConfigEnvelope(envelopeFor(wire));
    expect(decoded.markets).toEqual([]);
    expect(decoded.chains).toEqual([]);
  });

  test("carries real content through unchanged", () => {
    const original = create(GetConfigResponseSchema, {
      config: create(ConfigurationSchema, {
        chains: [
          create(ChainSchema, {
            architecture: "evm",
            canonicalName: "coston2",
            network: "flare-coston2",
            chainId: 114,
          }),
        ],
        markets: [],
      }),
    });
    const wire = toBinary(GetConfigResponseSchema, original);

    const decoded = decodeConfigEnvelope(envelopeFor(wire));
    expect(decoded.chains.length).toBe(1);
    expect(decoded.chains[0]?.network).toBe("flare-coston2");
  });

  /**
   * Protobuf is full of non-UTF-8 bytes. Anything that stringified the payload
   * instead of hex-encoding it would corrupt the config silently.
   */
  test("non-UTF-8 bytes survive the hex round-trip", () => {
    const raw = new Uint8Array([0x0a, 0x03, 0xff, 0xfe, 0xfd]);
    // Not a valid GetConfigResponse — we only assert the hex layer is faithful.
    expect(() => decodeConfigEnvelope(envelopeFor(raw))).toThrow();
    expect(bytesToHex(raw)).toBe("0x0a03fffefd");
  });

  /**
   * A malformed payload must THROW, never yield an empty config. An empty
   * config surfaces downstream as "market not found" and points the user at
   * their market id instead of at the transport.
   */
  test("malformed hex throws rather than yielding an empty config", () => {
    expect(() =>
      decodeConfigEnvelope({ configProto: "0xnothex" as never }),
    ).toThrow();
  });

  test("a response with no config throws", () => {
    const empty = toBinary(
      GetConfigResponseSchema,
      create(GetConfigResponseSchema, {}),
    );
    expect(() => decodeConfigEnvelope(envelopeFor(empty))).toThrow(/config/i);
  });
});
