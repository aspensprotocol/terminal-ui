"use client";

/**
 * TEE attestation viewer.
 *
 * Fetches `ConfigService.GetAttestation` on open and renders the raw
 * report fields. Users care about being able to *inspect* the report
 * (mr_td, rt_mr*, report_data, etc.) and copy values for offline
 * verification — so the UI is intentionally a flat key/value list of
 * monospace hex strings rather than a curated summary.
 *
 * Lazy fetch: we don't request the report until the dialog actually
 * opens. The signer call is cheap but not free, and most users will
 * never click the link.
 */

import { useCallback, useEffect, useState } from "react";
import type { AttestationReport } from "@aspens/terminal-sdk";
import { getExchangeClient } from "@/lib/api";
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
 * Render order for the report. Kept as a constant so the layout is stable
 * across renders and the labels read naturally rather than auto-derived
 * from the proto field names.
 */
const REPORT_FIELDS: ReadonlyArray<{
  key: keyof AttestationReport;
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
  { key: "reportData", label: "Report Data" },
];

export function AttestationDialog({
  open,
  onOpenChange,
}: AttestationDialogProps) {
  const [report, setReport] = useState<AttestationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getExchangeClient().getAttestation();
      if (!r) {
        setError(
          "No attestation report returned. The backend may not expose one.",
        );
        setReport(null);
      } else {
        setReport(r);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy-fetch on first open; refetch on every open so a stale report
  // from an earlier session doesn't linger.
  useEffect(() => {
    if (open) {
      fetchReport();
    }
  }, [open, fetchReport]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>TEE Attestation</DialogTitle>
          <DialogDescription>
            TDX attestation report from the arborter signer.
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
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[11px] font-mono">
              {REPORT_FIELDS.map(({ key, label }) => {
                const value = (report[key] as string | undefined) ?? "";
                return (
                  <div key={key} className="contents">
                    <dt className="text-muted-foreground/80 whitespace-nowrap py-1">
                      {label}
                    </dt>
                    <dd
                      className="text-foreground/90 break-all py-1 select-all"
                      title={value || "(empty)"}
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
            </dl>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
