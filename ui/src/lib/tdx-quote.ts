/**
 * Minimal client-side parser for an Intel TDX **TD Quote** (DCAP, v4/v5).
 *
 * The arborter signer returns only the authoritative `raw_quote` bytes and
 * leaves the proto's string measurement fields empty on purpose (design §4.6):
 * a verifier is meant to read MRTD/RTMR/etc. from the *verified* quote body,
 * not trust loose server-set strings. This parser decodes those fields from the
 * quote at their fixed offsets so the attestation viewer can display them.
 *
 * It does NOT verify the quote (no signature / TCB / PCK-chain checks) — it is a
 * display-only decode of the TD report body. Real verification is the SDK's
 * `tdx_verify` path.
 *
 * Layout (little-endian):
 *   Quote Header            48 bytes
 *     +0  version   u16   (4 or 5)
 *     +4  tee_type  u32   (0x00000081 = TDX)
 *   TD Report Body (TD10)  584 bytes, at offset 48 — TD15 (1.5) shares these
 *   first 584 bytes, so the same offsets work for both:
 *     +0   tee_tcb_svn       16
 *     +16  mr_seam           48
 *     +64  mr_signer_seam    48
 *     +112 seam_attributes    8
 *     +120 td_attributes      8
 *     +128 xfam               8
 *     +136 mr_td             48
 *     +184 mr_config_id      48
 *     +232 mr_owner          48
 *     +280 mr_owner_config   48
 *     +328 rt_mr0            48
 *     +376 rt_mr1            48
 *     +424 rt_mr2            48
 *     +472 rt_mr3            48
 *     +520 report_data       64
 */

const TEE_TYPE_TDX = 0x81;
const HEADER_LEN = 48;
const BODY_LEN = 584;

export interface ParsedTdxQuote {
  version: number;
  teeType: string;
  teeTcbSvn: string;
  mrSeam: string;
  mrSignerSeam: string;
  seamAttributes: string;
  tdAttributes: string;
  xfam: string;
  mrTd: string;
  mrConfigId: string;
  mrOwner: string;
  mrOwnerConfig: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
  rtMr3: string;
  reportData: string;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Decode a TDX TD Quote's report-body fields. Returns null if the bytes are
 * too short or aren't a TDX quote (so callers can fall back gracefully).
 */
export function parseTdxQuote(
  raw: Uint8Array | undefined,
): ParsedTdxQuote | null {
  if (!raw || raw.length < HEADER_LEN + BODY_LEN) return null;

  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = dv.getUint16(0, true);
  const teeType = dv.getUint32(4, true);
  if (teeType !== TEE_TYPE_TDX) return null;

  const field = (off: number, len: number) =>
    toHex(raw.subarray(HEADER_LEN + off, HEADER_LEN + off + len));

  return {
    version,
    teeType: "0x" + teeType.toString(16).padStart(8, "0"),
    teeTcbSvn: field(0, 16),
    mrSeam: field(16, 48),
    mrSignerSeam: field(64, 48),
    seamAttributes: field(112, 8),
    tdAttributes: field(120, 8),
    xfam: field(128, 8),
    mrTd: field(136, 48),
    mrConfigId: field(184, 48),
    mrOwner: field(232, 48),
    mrOwnerConfig: field(280, 48),
    rtMr0: field(328, 48),
    rtMr1: field(376, 48),
    rtMr2: field(424, 48),
    rtMr3: field(472, 48),
    reportData: field(520, 64),
  };
}
