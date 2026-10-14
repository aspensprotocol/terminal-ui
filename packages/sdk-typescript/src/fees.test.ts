/**
 * `feeForVolume` against what MidribV3 actually accepts.
 *
 * The expected fees were established by running `settleBatch` on a real
 * MidribV3 instance (arborter `chains/evm`, a throwaway forge test reusing
 * `MidribV3Test`'s setup: maintenance 100 bps, operator 50 bps). For each
 * gross volume the contract ACCEPTED a batch whose deltas netted to minus the
 * expected value below, and REVERTED `SETTLE_NOT_CONSERVED` on a batch netting
 * to minus the single-floor figure `floor(G × 150 / 10000)`. Both volumes are
 * chosen so the two roundings differ, so an implementation that floors once
 * on the summed rate fails here.
 */

import { describe, expect, test } from "bun:test";

import { FEE_DENOMINATOR, feeForVolume } from "./fees.js";

describe("feeForVolume", () => {
  test("floors the maintenance and operator fees separately (large volume)", () => {
    // Contract-accepted: 15000000000000001. Contract-refused: 15000000000000002.
    expect(feeForVolume(1_000_000_000_000_000_199n, 100, 50)).toBe(
      15_000_000_000_000_001n,
    );
  });

  test("floors the maintenance and operator fees separately (small volume)", () => {
    // 199 × 1% = 1.99 → 1, 199 × 0.5% = 0.995 → 0. Contract-accepted: 1;
    // contract-refused: floor(2.985) = 2.
    expect(feeForVolume(199n, 100, 50)).toBe(1n);
  });

  test("an exact volume has no rounding (arborter test_settleBatchSkimsBothFees)", () => {
    expect(feeForVolume(100n * 10n ** 18n, 100, 50)).toBe(15n * 10n ** 17n);
  });

  test("zero rates and zero volume charge nothing", () => {
    expect(feeForVolume(123_456_789n, 0, 0)).toBe(0n);
    expect(feeForVolume(0n, 100, 50)).toBe(0n);
  });

  test("refuses a negative volume and out-of-range rates", () => {
    expect(() => feeForVolume(-1n, 100, 50)).toThrow(RangeError);
    expect(() => feeForVolume(1n, -1, 0)).toThrow(RangeError);
    expect(() => feeForVolume(1n, 0, 65_536)).toThrow(RangeError);
    expect(() => feeForVolume(1n, 1.5, 0)).toThrow(RangeError);
  });

  test("the denominator is 10000", () => {
    expect(FEE_DENOMINATOR).toBe(10_000n);
  });
});
