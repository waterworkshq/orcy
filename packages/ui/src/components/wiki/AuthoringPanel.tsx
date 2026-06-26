import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Loader2,
  Lightbulb,
  Activity,
  Code,
  Clock,
  MessageSquare,
  Zap,
} from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { useDebounce } from "../../hooks/useDebounce.js";

interface AuthoringPanelProps {
  habitatId: string;
  /** When set: delta mode (primitives changed since this page's last version). */
  pageId?: string;
  /** Edit content length for optional debounced refresh signal. */
  contentLength?: number;
}

type ChunkPreset = "7d" | "30d" | "90d";

const PRIMITIVE_GROUPS: Array<{
  key: string;
  label: string;
  icon: typeof Zap;
}> = [
  { key: "pulses", label: "Pulses", icon: Zap },
  { key: "skillSignals", label: "Skill Signals", icon: Activity },
  { key: "insights", label: "Insights", icon: Lightbulb },
  { key: "evidence", label: "Code Evidence", icon: Code },
  { key: "effort", label: "Effort", icon: Clock },
  { key: "comments", label: "Comments", icon: MessageSquare },
];

export function AuthoringPanel({ habitatId, pageId, contentLength }: AuthoringPanelProps) {
  const [preset, setPreset] = useState<ChunkPreset>("30d");
  const [manualRefresh, setManualRefresh] = useState(0);
  const debouncedLength = useDebounce(contentLength ?? 0, 3500);

  const isDelta = !!pageId;

  const { from, to } = chunkRange(preset);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: [
      "wiki",
      "authoringContext",
      habitatId,
      pageId ?? "chunk",
      isDelta ? null : preset,
      manualRefresh,
      isDelta ? debouncedLength : 0,
    ],
    queryFn: () => {
      if (isDelta) {
        return wikiApi.getAuthoringContextForEdit(habitatId, pageId);
      }
      return wikiApi.getAuthoringContextForChunk(habitatId, { from, to });
    },
    staleTime: 60 * 1000,
  });

  const context = data ?? {};
  const totalCount = PRIMITIVE_GROUPS.reduce((n, g) => n + countGroup(context[g.key]), 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider flex items-center gap-1">
          <Lightbulb className="h-3 w-3" /> Authoring Context
        </h4>
        <button
          type="button"
          onClick={() => {
            setManualRefresh((n) => n + 1);
            refetch();
          }}
          disabled={isFetching}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--on-surface-variant)] hover:text-[var(--on-surface)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
          title="Refresh context"
        >
          {isFetching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </div>

      {!isDelta && (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-[var(--on-surface-variant)] shrink-0">Range:</span>
          {(Object.keys(CHUNK_PRESETS) as ChunkPreset[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPreset(p)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                preset === p
                  ? "bg-[var(--primary)] text-[var(--on-primary)]"
                  : "text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)]"
              }`}
            >
              {CHUNK_PRESETS[p]}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--on-surface-variant)]" />
        </div>
      ) : totalCount === 0 ? (
        <p className="text-[10px] text-[var(--on-surface-variant)] italic py-2">
          {isDelta
            ? "No new primitives since the last version of this page."
            : "No primitives found in the selected range."}
        </p>
      ) : (
        <div className="space-y-1.5">
          {PRIMITIVE_GROUPS.map((group) => {
            const items = asArray(context[group.key]);
            if (items.length === 0) return null;
            return (
              <PrimitiveGroup key={group.key} label={group.label} icon={group.icon} items={items} />
            );
          })}
        </div>
      )}
    </div>
  );
}

const CHUNK_PRESETS: Record<ChunkPreset, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

function chunkRange(preset: ChunkPreset): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - parseInt(preset, 10));
  return { from: from.toISOString(), to: to.toISOString() };
}

function PrimitiveGroup({
  label,
  icon: Icon,
  items,
}: {
  label: string;
  icon: typeof Zap;
  items: Record<string, unknown>[];
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)]">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-[var(--on-surface-variant)] shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-[var(--on-surface-variant)] shrink-0" />
        )}
        <Icon className="h-3 w-3 text-[var(--primary)] shrink-0" />
        <span className="text-[10px] font-semibold text-[var(--on-surface)]">{label}</span>
        <span className="text-[9px] text-[var(--on-surface-variant)] shrink-0">
          ({items.length})
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5">
          {items.map((item, i) => (
            <PrimitiveItem key={i} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function PrimitiveItem({ item }: { item: Record<string, unknown> }) {
  const subject = str(item, "subject") || str(item, "title") || "—";
  const body =
    str(item, "body") || str(item, "summary") || str(item, "note") || str(item, "content") || "";
  const ts = str(item, "createdAt") || str(item, "updatedAt") || str(item, "lastSeenAt") || "";
  return (
    <div className="rounded border border-[var(--outline-variant)]/60 bg-[var(--surface)] px-2 py-1.5">
      <p className="text-[10px] font-medium text-[var(--on-surface)] line-clamp-2">{subject}</p>
      {body && (
        <p className="text-[9px] text-[var(--on-surface-variant)] line-clamp-3 mt-0.5">{body}</p>
      )}
      {ts && (
        <p className="text-[8px] text-[var(--on-surface-variant)]/70 mt-0.5">
          {new Date(ts).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function countGroup(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}
