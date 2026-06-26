import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Signal, AlertTriangle, TrendingUp, TrendingDown } from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { queryKeys } from "../../lib/queryKeys.js";
import type { WikiExperienceAggregate } from "../../types/index.js";

interface ExperienceSignalsTabProps {
  habitatId: string;
}

const TIME_WINDOWS = [
  { label: "7 days", value: "7 days" },
  { label: "30 days", value: "30 days" },
  { label: "90 days", value: "90 days" },
] as const;

export function ExperienceSignalsTab({ habitatId }: ExperienceSignalsTabProps) {
  const [timeWindow, setTimeWindow] = useState<(typeof TIME_WINDOWS)[number]["value"]>("30 days");

  const {
    data: surface,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.wiki.signalSurface(habitatId, `experience:${timeWindow}`),
    queryFn: () => wikiApi.getSignalSurface(habitatId, { signalClass: "experience", timeWindow }),
    staleTime: 60 * 1000,
  });

  const patterns = surface?.experiencePatterns ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
          Time window
        </span>
        <div className="flex rounded-md border border-[var(--outline-variant)] overflow-hidden">
          {TIME_WINDOWS.map((tw) => (
            <button
              key={tw.value}
              type="button"
              onClick={() => setTimeWindow(tw.value)}
              className={`px-2.5 py-1 text-xs font-semibold transition-colors ${
                timeWindow === tw.value
                  ? "bg-[var(--primary)] text-[var(--on-primary)]"
                  : "bg-[var(--surface-container-low)] text-[var(--on-surface-variant)] hover:bg-[var(--surface-container)]"
              }`}
            >
              {tw.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-[var(--on-surface-variant)] ml-auto italic">
          Aggregated only — individual signals are not exposed.
        </span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--error)] gap-2">
          <AlertTriangle className="h-6 w-6 opacity-60" />
          <span className="text-xs">Failed to load experience signals.</span>
        </div>
      ) : patterns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--on-surface-variant)] gap-2">
          <Signal className="h-6 w-6 opacity-30" />
          <span className="text-xs">
            No experience patterns in this window. Patterns accumulate as agents report experience
            signals.
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          {patterns.map((pattern) => (
            <PatternRow key={pattern.id} pattern={pattern} />
          ))}
        </div>
      )}
    </div>
  );
}

const CATEGORY_COLORS: Record<string, string> = {
  pitfall: "var(--error)",
  anti_patterns: "var(--error)",
  domain_knowledge: "hsl(280,70%,60%)",
  pattern: "var(--tertiary)",
};

function PatternRow({ pattern }: { pattern: WikiExperienceAggregate }) {
  const color = CATEGORY_COLORS[pattern.skillCategory] ?? "var(--primary)";
  return (
    <div
      className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container-low)] p-3 space-y-2"
      style={{ borderLeftWidth: "3px", borderLeftColor: color }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
          style={{
            backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
            color,
          }}
        >
          {pattern.skillCategory}
        </span>
        <span className="text-[10px] text-[var(--on-surface-variant)] bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
          {pattern.sourceSignalType}
        </span>
        <span className="text-[10px] text-[var(--on-surface-variant)] ml-auto">
          freq {pattern.frequency}
        </span>
      </div>

      <p className="text-sm font-semibold text-[var(--on-surface)] leading-snug">
        {pattern.subject}
      </p>
      {pattern.summary && (
        <p className="text-xs text-[var(--on-surface-variant)] line-clamp-2">{pattern.summary}</p>
      )}

      <div className="flex items-center gap-3 text-[10px] text-[var(--on-surface-variant)] pt-0.5 flex-wrap">
        <span>
          {pattern.corroboratingAgents} agent{pattern.corroboratingAgents !== 1 ? "s" : ""}
        </span>
        <span className="inline-flex items-center gap-0.5 text-[var(--tertiary)]">
          <TrendingUp className="h-3 w-3" />
          {pattern.successfulTasks} ok
        </span>
        {pattern.failedTasks > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[var(--error)]">
            <TrendingDown className="h-3 w-3" />
            {pattern.failedTasks} fail
          </span>
        )}
        <span className="opacity-60">
          {new Date(pattern.firstSeenAt).toLocaleDateString()} →{" "}
          {new Date(pattern.lastSeenAt).toLocaleDateString()}
        </span>
      </div>
    </div>
  );
}
