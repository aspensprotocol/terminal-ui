/**
 * The trade contracts' settlement fee.
 *
 * Per token per settled batch, both MidribV3 (`settleBatch`) and the Solana
 * midrib program (`settle_batch`) charge
 *
 *     floor(G × maintenanceBps / 10000) + floor(G × operatorBps / 10000)
 *
 * where G is the gross volume takers received in that token during the batch.
 * The two fees are floored SEPARATELY, so the total can be one base unit less
 * than `floor(G × (maintenanceBps + operatorBps) / 10000)`. The contracts
 * refuse a batch whose deltas do not net to exactly minus this figure, so a
 * caller predicting a settled delta must use the same rounding.
 */

/** Basis-point denominator of the fee rates. */
export const FEE_DENOMINATOR = 10_000n;

const U16_MAX = 0xffff;

function checkBps(name: string, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > U16_MAX) {
    throw new RangeError(
      `${name} must be an integer in 0..${U16_MAX}, got ${bps}`,
    );
  }
  return BigInt(bps);
}

/**
 * The fee a trade contract skims from `gross` base units of taker volume:
 * the maintenance and operator fees, each floored on its own, summed.
 */
export function feeForVolume(
  gross: bigint,
  maintenanceBps: number,
  operatorBps: number,
): bigint {
  if (gross < 0n) {
    throw new RangeError(`gross volume must not be negative, got ${gross}`);
  }
  const m = checkBps("maintenanceBps", maintenanceBps);
  const o = checkBps("operatorBps", operatorBps);
  return (gross * m) / FEE_DENOMINATOR + (gross * o) / FEE_DENOMINATOR;
}
