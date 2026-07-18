/**
 * Wire-encoding pinning tests for the `hidden` Order flag.
 *
 * The order envelope signature is computed over the serialized Order
 * proto, and arborter re-encodes the decoded order to verify it. Two
 * invariants must hold or signed orders silently fail verification:
 *
 *   1. `hidden: false` (or omitted) is wire-skipped — byte-identical to
 *      a pre-feature encoding, so existing users' digests are stable.
 *   2. `hidden: true` actually reaches the wire.
 */

import { describe, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import { OrderSchema } from "./protos/arborter_pb.js";
import { createOrderMessage, type OrderSigningData } from "./signing.js";

const base: OrderSigningData = {
  side: "buy",
  quantity: "1000",
  price: "50000",
  marketId: "base::0xaa::quote::0xbb",
  baseAccountAddress: "0xb",
  quoteAccountAddress: "0xq",
  postOnly: false,
};

describe("hidden flag wire encoding", () => {
  test("hidden=false and omitted are byte-identical (wire-skipped)", () => {
    const explicit = toBinary(
      OrderSchema,
      createOrderMessage({ ...base, hidden: false }),
    );
    const omitted = toBinary(OrderSchema, createOrderMessage({ ...base }));
    expect(explicit).toEqual(omitted);
  });

  test("hidden=true reaches the wire", () => {
    const plain = toBinary(OrderSchema, createOrderMessage({ ...base }));
    const flagged = toBinary(
      OrderSchema,
      createOrderMessage({ ...base, hidden: true }),
    );
    expect(flagged).not.toEqual(plain);
    expect(flagged.length).toBeGreaterThan(plain.length);
  });
});
