import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, FlaskConical, AlertTriangle } from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { queryKeys } from "../../lib/queryKeys.js";

interface EngineeringFindingsTabProps {
  habitatId: string;
}

const SEVERITY_FILTERS = ["all", "critical", "high", "medium", "low"] as const;

const SEVERITY_COLORS: Record<string, string> = {
  critical: "var(--error)",
  high: "#f97316",
  medium: "hsl(40,90%,55%)",
  low: "var(--on-surface-variant)",
};

interface FindingRecord {
  id?: string;
  subject?: string;
  body?: string;
  fromType?: string;
  fromId?: string;
  createdBy?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

function asFinding(r: Record<string, unknown>): FindingRecord {
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    subject: typeof r.subject === "string" ? r.subject : undefined,
    body: typeof r.body === "string" ? r.body : undefined,
    fromType: typeof r.fromType === "string" ? r.fromType : undefined,
    fromId: typeof r.fromId === "string" ? r.fromId : undefined,
    createdBy: typeof r.createdBy === "string" ? r.createdBy : undefined,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined,
    metadata:
      r.metadata && typeof r.metadata === "object"
        ? (r.metadata as Record<string, unknown>)
        : undefined,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function EngineeringFindingsTab({ habitatId }: EngineeringFindingsTabProps) {
  const [severityFilter, setSeverityFilter] = useState<(typeof SEVERITY_FILTERS)[number]>("all");

  const {
    data: surface,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.wiki.signalSurface(habitatId, "findings"),
    queryFn: () => wikiApi.getSignalSurface(habitatId, { signalClass: "finding" }),
    staleTime: 60 * 1000,
  });

  const structured = useMemo(() => (surface?.findings ?? []).map(asFinding), [surface?.findings]);
  const unstructured = useMemo(
    () => (surface?.unstructuredFindings ?? []).map(asFinding),
    [surface?.unstructuredFindings],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, FindingRecord[]>();
    structured.forEach((f) => {
      const kind = str(f.metadata?.findingKind) ?? "unknown";
      const sev = str(f.metadata?.severity);
      if (severityFilter !== "all" && sev !== severityFilter) return;
      const bucket = map.get(kind) ?? [];
      bucket.push(f);
      map.set(kind, bucket);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [structured, severityFilter]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
          Severity
        </span>
        <div className="flex rounded-md border border-[var(--outline-variant)] overflow-hidden">
          {SEVERITY_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSeverityFilter(s)}
              className={`px-2.5 py-1 text-xs font-semibold transition-colors capitalize ${
                severityFilter === s
                  ? "bg-[var(--primary)] text-[var(--on-primary)]"
                  : "bg-[var(--surface-container-low)] text-[var(--on-surface-variant)] hover:bg-[var(--surface-container)]"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-[var(--on-surface-variant)] ml-auto">
          {structured.length} structured · {unstructured.length} unstructured
        </span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--error)] gap-2">
          <AlertTriangle className="h-6 w-6 opacity-60" />
          <span className="text-xs">Failed to load engineering findings.</span>
        </div>
      ) : structured.length === 0 && unstructured.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--on-surface-variant)] gap-2">
          <FlaskConical className="h-6 w-6 opacity-30" />
          <span className="text-xs">
            No engineering findings yet. Agents post findings via pulses during implementation.
          </span>
        </div>
      ) : (
        <>
          {grouped.length > 0 && (
            <section>
              <h3 className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider mb-2">
                Structured findings
              </h3>
              <div className="space-y-3">
                {grouped.map(([kind, items]) => (
                  <div key={kind}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-bold text-[var(--on-surface)] uppercase tracking-wide">
                        {kind}
                      </span>
                      <span className="text-[10px] text-[var(--on-surface-variant)]">
                        ({items.length})
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {items.map((f) => (
                        <StructuredFindingRow key={f.id ?? f.subject} finding={f} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {unstructured.length > 0 && (
            <section>
              <h3 className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider mb-2">
                Unstructured findings
              </h3>
              <div className="space-y-1.5">
                {unstructured.map((f) => (
                  <UnstructuredFindingRow key={f.id ?? f.subject} finding={f} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Attribution({ finding }: { finding: FindingRecord }) {
  const who = finding.fromId ?? finding.createdBy;
  return (
    <div className="flex items-center gap-2 text-[10px] text-[var(--on-surface-variant)]">
      {finding.fromType && (
        <span className="bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
          {finding.fromType}
        </span>
      )}
      {who && <span>by {who.slice(0, 8)}</span>}
      {finding.createdAt && <span>· {new Date(finding.createdAt).toLocaleDateString()}</span>}
    </div>
  );
}

function StructuredFindingRow({ finding }: { finding: FindingRecord }) {
  const sev = str(finding.metadata?.severity);
  const sevColor = sev
    ? (SEVERITY_COLORS[sev] ?? "var(--on-surface-variant)")
    : "var(--on-surface-variant)";
  const files = strArr(finding.metadata?.affectedFiles);

  return (
    <div className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container-low)] p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        {sev && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
            style={{
              backgroundColor: `color-mix(in srgb, ${sevColor} 15%, transparent)`,
              color: sevColor,
            }}
          >
            <AlertTriangle className="h-3 w-3" />
            {sev}
          </span>
        )}
        {str(finding.metadata?.findingKind) && (
          <span className="text-[10px] text-[var(--on-surface-variant)] bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
            {str(finding.metadata?.findingKind)}
          </span>
        )}
        <div className="ml-auto">
          <Attribution finding={finding} />
        </div>
      </div>
      <p className="text-sm font-semibold text-[var(--on-surface)] leading-snug">
        {finding.subject ?? "(no subject)"}
      </p>
      {finding.body && (
        <p className="text-xs text-[var(--on-surface-variant)] line-clamp-3">{finding.body}</p>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {files.map((file) => (
            <code
              key={file}
              className="text-[10px] bg-[var(--surface-container-high)] text-[var(--on-surface-variant)] px-1.5 py-0.5 rounded"
            >
              {file}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

function UnstructuredFindingRow({ finding }: { finding: FindingRecord }) {
  return (
    <div className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] p-2.5 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-[var(--on-surface)] truncate">
          {finding.subject ?? "(no subject)"}
        </p>
        <Attribution finding={finding} />
      </div>
      {finding.body && (
        <p className="text-xs text-[var(--on-surface-variant)] line-clamp-2">{finding.body}</p>
      )}
    </div>
  );
}
