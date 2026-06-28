import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Radar, AlertTriangle } from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { queryKeys } from "../../lib/queryKeys.js";

interface DetectedSignalsTabProps {
  habitatId: string;
}

interface DetectedSignalRecord {
  id?: string;
  subject?: string;
  body?: string;
  fromType?: string;
  fromId?: string;
  createdBy?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

function asSignal(r: Record<string, unknown>): DetectedSignalRecord {
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

/**
 * Wiki signal-surface tab for plugin-detected signals (ADR-0013). Provenance-distinct
 * from agent self-reported experience signals and agent-authored engineering findings —
 * these rows come from plugin detector contributions running over habitat artifacts.
 */
export function DetectedSignalsTab({ habitatId }: DetectedSignalsTabProps) {
  const {
    data: surface,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.wiki.signalSurface(habitatId, "detected"),
    queryFn: () => wikiApi.getSignalSurface(habitatId, { signalClass: "detected" }),
    staleTime: 60 * 1000,
  });

  const signals = useMemo(
    () => (surface?.detectedSignals ?? []).map((r) => asSignal(r)),
    [surface?.detectedSignals],
  );

  return (
    <div className="space-y-3">
      <p className="text-[10px] text-[var(--on-surface-variant)] italic">
        Plugin detector output — provenance-distinct from agent self-report (ADR-0013).
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--error)] gap-2">
          <AlertTriangle className="h-6 w-6 opacity-60" />
          <span className="text-xs">Failed to load detected signals.</span>
        </div>
      ) : signals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--on-surface-variant)] gap-2">
          <Radar className="h-6 w-6 opacity-30" />
          <span className="text-xs">
            No detected signals. Plugin detectors emit these when scanning habitat artifacts.
          </span>
        </div>
      ) : (
        <div className="space-y-1.5">
          {signals.map((s) => (
            <DetectedSignalRow key={s.id ?? s.subject} signal={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function DetectedSignalRow({ signal }: { signal: DetectedSignalRecord }) {
  const detectorPluginId = str(signal.metadata?.detector) ?? str(signal.metadata?.pluginId);
  const signalKind = str(signal.metadata?.signalKind) ?? str(signal.metadata?.kind);
  return (
    <div className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] p-2.5 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        {signalKind && (
          <span className="text-[10px] font-semibold uppercase tracking-wider bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
            {signalKind}
          </span>
        )}
        {detectorPluginId && (
          <span className="text-[10px] text-[var(--on-surface-variant)] inline-flex items-center gap-1">
            <Radar className="h-3 w-3" />
            detector: <code>{detectorPluginId}</code>
          </span>
        )}
        <div className="ml-auto text-[10px] text-[var(--on-surface-variant)]">
          {signal.createdAt && <span>{new Date(signal.createdAt).toLocaleDateString()}</span>}
        </div>
      </div>
      <p className="text-sm font-medium text-[var(--on-surface)] leading-snug">
        {signal.subject ?? "(no subject)"}
      </p>
      {signal.body && (
        <p className="text-xs text-[var(--on-surface-variant)] line-clamp-3">{signal.body}</p>
      )}
    </div>
  );
}
