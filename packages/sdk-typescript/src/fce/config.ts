/**
 * Config discovery over the FCE transport.
 *
 * The adapter relays the arborter's `GetConfigResponse` as its canonical
 * PROTOBUF encoding, hex on the wire — not a JSON mirror of the config schema.
 * The adapter never reads those bytes, so it needs no bindings for that proto
 * and no rebuild when a field is added; that matters because it ships inside
 * the measured Confidential Space image, where any change costs a Flare
 * re-registration. Decoding happens here against the SAME generated type the
 * gRPC path returns, so both transports yield an identical `Configuration`.
 */

import { fromBinary } from "@bufbuild/protobuf";
import type { Hex } from "viem";
import {
  type Configuration,
  GetConfigResponseSchema,
} from "../protos/arborter_config_pb.js";
import { hexBytesToBytes } from "./wire.js";

/** GET_CONFIG takes no arguments — the arborter's request message is empty. */
export type GetConfigRequest = Record<string, never>;

/** `{"configProto": "0x<protobuf>"}` — the adapter's one-field envelope. */
export interface GetConfigEnvelope {
  /** `0x`-hex of `GetConfigResponse`'s protobuf encoding. */
  configProto: Hex;
}

/**
 * Decode the envelope into the arborter `Configuration`.
 *
 * Throws on every failure rather than returning an empty config: an empty
 * config surfaces downstream as "market not found", which points at the
 * caller's market id instead of at the transport that actually failed.
 */
export function decodeConfigEnvelope(env: GetConfigEnvelope): Configuration {
  const bytes = hexBytesToBytes(env.configProto);
  if (bytes.length === 0) {
    throw new Error("GET_CONFIG returned an empty configProto");
  }
  const response = fromBinary(GetConfigResponseSchema, bytes);
  if (!response.config) {
    throw new Error(
      "GET_CONFIG returned a GetConfigResponse with no config field",
    );
  }
  return response.config;
}
