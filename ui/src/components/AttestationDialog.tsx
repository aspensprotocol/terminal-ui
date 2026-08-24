"use client";

/**
 * TEE attestation viewer — challenge-response.
 *
 * On open, mints a fresh random 32-byte nonce, fetches
 * `ConfigService.GetAttestation` with it, and renders the measurement fields
 * decoded from the returned TD Quote.
 *
 * The report carries only the authoritative `raw_quote` (plus optional
 * cert chain / self-reported image digest) — there are no server-set
 * measurement strings, on purpose: measurements are meant to be read from the
 * *verified* quote body. We decode them client-side from `raw_quote` for
 * display (not a verification).
 *
 * The signer binds the nonce into the quote's REPORTDATA as
 * `SHA-512(DOMAIN ‖ SHA256(pubkey_manifest) ‖ SHA256(image_digests) ‖ SHA256(nonce))`,
 * so the quote *commits* to the nonce we minted for this fetch — a recorded
 * quote from an earlier session can never carry this REPORTDATA. Checking that
 * binding (and the Intel signature chain and pinned measurements) requires
 * operator-known keys, so it stays an offline step:
 * `aspens-cli verify-attestation --nonce <hex>`.
 *
 * Lazy fetch: we don't request the report until the dialog actually
 * opens. The signer call is cheap but not free, and most users will
 * never click the link.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AttestationReport } from "@aspens/terminal-sdk";
import { getExchangeClient } from "@/lib/api";
import { parseTdxQuote, type ParsedTdxQuote } from "@/lib/tdx-quote";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AttestationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Render order for the fields decoded from the TD Quote body. Kept as a
 * constant so the layout is stable across renders and the labels read
 * naturally rather than auto-derived from the struct field names.
 */
const QUOTE_FIELDS: ReadonlyArray<{
  key: keyof ParsedTdxQuote;
  label: string;
}> = [
  { key: "teeTcbSvn", label: "TEE TCB SVN" },
  { key: "mrSeam", label: "MR_SEAM" },
  { key: "mrSignerSeam", label: "MR_SIGNER_SEAM" },
  { key: "seamAttributes", label: "SEAM Attributes" },
  { key: "tdAttributes", label: "TD Attributes" },
  { key: "xfam", label: "XFAM" },
  { key: "mrTd", label: "MR_TD" },
  { key: "mrConfigId", label: "MR_CONFIG_ID" },
  { key: "mrOwner", label: "MR_OWNER" },
  { key: "mrOwnerConfig", label: "MR_OWNER_CONFIG" },
  { key: "rtMr0", label: "RT_MR0" },
  { key: "rtMr1", label: "RT_MR1" },
  { key: "rtMr2", label: "RT_MR2" },
  { key: "rtMr3", label: "RT_MR3" },
  { key: "reportData", label: "REPORTDATA" },
];

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function AttestationDialog({
  open,
  onOpenChange,
}: AttestationDialogProps) {
  const [report, setReport] = useState<AttestationReport | null>(null);
  const [nonceHex, setNonceHex] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fresh challenge per fetch: the signer folds SHA256(nonce) into the
      // quote's REPORTDATA, so this response can't be a replay.
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const r = await getExchangeClient().getAttestation(nonce);
      if (!r) {
        setError(
          "No attestation report returned. The backend may not expose one.",
        );
        setReport(null);
        setNonceHex(null);
      } else if (r.rawQuote.length === 0) {
        setError(
          "The signer returned no TD Quote — it is not running in an attesting TEE.",
        );
        setReport(null);
        setNonceHex(null);
      } else {
        setReport(r);
        setNonceHex(toHex(nonce));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setReport(null);
      setNonceHex(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy-fetch on first open; refetch on every open so each viewing is a
  // fresh challenge rather than a stale report from an earlier session.
  useEffect(() => {
    if (open) {
      fetchReport();
    }
  }, [open, fetchReport]);

  // Decode the measurement fields from the raw TD Quote. Memoized on the
  // quote bytes.
  const parsed: ParsedTdxQuote | null = useMemo(
    () => parseTdxQuote(report?.rawQuote),
    [report?.rawQuote],
  );

  const imageDigest = useMemo(() => {
    if (!report || report.imageDigest.length === 0) return null;
    return new TextDecoder().decode(report.imageDigest).trim();
  }, [report]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>TEE Attestation</DialogTitle>
          <DialogDescription>
            TDX attestation from the arborter signer, challenged with a fresh
            nonce.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Fetching attestation…
          </div>
        )}

        {!loading && error && (
          <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
            {error}
          </div>
        )}

        {!loading && !error && report && (
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            {parsed ? (
              <p className="text-[11px] text-muted-foreground/70 mb-2">
                Decoded from the TD Quote (v{parsed.version},{" "}
                {report.rawQuote.length} bytes, TEE {parsed.teeType}).
                Display-only — not a verification.
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground/70 mb-2">
                The signer returned {report.rawQuote.length} bytes that do not
                decode as a TDX TD Quote.
              </p>
            )}
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[11px] font-mono">
              {nonceHex && (
                <div className="contents">
                  <dt className="text-muted-foreground/80 whitespace-nowrap py-1">
                    Challenge Nonce
                  </dt>
                  <dd
                    className="text-foreground/90 break-all py-1 select-all"
                    title={nonceHex}
                  >
                    {nonceHex}
                  </dd>
                </div>
              )}
              {parsed &&
                QUOTE_FIELDS.map(({ key, label }) => {
                  const value = parsed[key];
                  return (
                    <div key={key} className="contents">
                      <dt className="text-muted-foreground/80 whitespace-nowrap py-1">
                        {label}
                      </dt>
                      <dd
                        className="text-foreground/90 break-all py-1 select-all"
                        title={typeof value === "string" ? value : ""}
                      >
                        {value || (
                          <span className="text-muted-foreground/40">
                            (empty)
                          </span>
                        )}
                      </dd>
                    </div>
                  );
                })}
              {imageDigest && (
                <div className="contents">
                  <dt className="text-muted-foreground/80 whitespace-nowrap py-1">
                    Image Digest
                  </dt>
                  <dd className="text-foreground/90 break-all py-1 select-all">
                    {imageDigest}
                  </dd>
                </div>
              )}
            </dl>
            <p className="text-[11px] text-muted-foreground/60 mt-3">
              REPORTDATA commits to this challenge nonce — the signer computes
              it as SHA-512 over its pubkey manifest, image digests, and
              SHA256(nonce), so a stored quote cannot answer a fresh challenge.
              Full verification (Intel signature chain, pinned measurements,
              nonce binding) is offline:{" "}
              <span className="select-all">
                aspens-cli verify-attestation --nonce {nonceHex ?? "<hex>"}
              </span>
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
