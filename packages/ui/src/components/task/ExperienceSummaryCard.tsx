import React from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../../api/index.js";
import {
  EXPERIENCE_CATEGORY_BADGES,
  EXPERIENCE_CATEGORY_LABELS,
  EXPERIENCE_CATEGORY_ORDER,
  formatExperienceTiming,
  getExperienceCategory,
} from "../../lib/experienceSignals.js";
import { queryKeys } from "../../lib/queryKeys.js";
import type { Agent, ExperienceCategory, Pulse } from "../../types/index.js";

function posterName(pulse: Pulse, agents: Agent[]): string {
  if (pulse.fromType === "system") return "System";
  const agent = agents.find((a) => a.id === pulse.fromId);
  return agent?.name ?? pulse.fromId.slice(0, 8);
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function ExperienceBody({ body }: { body: string }) {
  const [expanded, setExpanded] = React.useState(false);
  if (!body) return null;
  const shouldTruncate = body.length > 180;
  const text = shouldTruncate && !expanded ? `${body.slice(0, 180)}...` : body;
  return (
    <div className="space-y-1">
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--on-surface-variant)]">
        {text}
      </p>
      {shouldTruncate && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] font-semibold uppercase tracking-wider text-[var(--primary)] hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

interface ExperienceSummaryCardProps {
  taskId: string;
  missionId: string | null | undefined;
  agents: Agent[];
}

/** Displays aggregated task-level agent experience signals with expandable signal detail. */
export function ExperienceSummaryCard({ taskId, missionId, agents }: ExperienceSummaryCardProps) {
  const [expanded, setExpanded] = React.useState(false);
  const { data } = useQuery({
    queryKey: missionId ? queryKeys.pulse.byTask(missionId, taskId) : ["pulses", "byTask", taskId],
    queryFn: () =>
      api.pulse.listByMission(missionId!, {
        signalType: "experience",
        taskId,
        limit: 200,
      }),
    enabled: !!missionId,
    staleTime: 30 * 1000,
  });

  const signals = (data?.items ?? [])
    .filter((pulse) => pulse.signalType === "experience" && pulse.taskId === taskId)
    .map((pulse) => ({ pulse, category: getExperienceCategory(pulse) }))
    .filter(
      (item): item is { pulse: Pulse; category: ExperienceCategory } => item.category !== null,
    )
    .toSorted((a, b) => Date.parse(b.pulse.createdAt) - Date.parse(a.pulse.createdAt));

  if (signals.length === 0) return null;

  const counts = signals.reduce<Partial<Record<ExperienceCategory, number>>>((acc, item) => {
    acc[item.category] = (acc[item.category] ?? 0) + 1;
    return acc;
  }, {});
  const summary = EXPERIENCE_CATEGORY_ORDER.filter((category) => counts[category])
    .map((category) => `${counts[category]} ${EXPERIENCE_CATEGORY_LABELS[category]}`)
    .join(" · ");

  return (
    <div className="mb-4 rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)]/50 p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-[var(--primary)]/10 p-1.5 text-[var(--primary)]">
          <BarChart3 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-[var(--on-surface)]">
              Agent experience: {signals.length} {signals.length === 1 ? "signal" : "signals"}
            </h3>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--primary)] hover:underline"
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {expanded ? "Collapse" : "Expand"}
            </button>
          </div>
          <p className="text-xs text-[var(--on-surface-variant)]">{summary}</p>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-[var(--outline-variant)]/50 pt-3">
          {signals.map(({ pulse, category }) => {
            const timing = formatExperienceTiming(pulse);
            return (
              <article
                key={pulse.id}
                className="rounded-md border border-[var(--outline-variant)]/70 bg-[var(--surface-container-low)]/60 p-3"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${EXPERIENCE_CATEGORY_BADGES[category]}`}
                  >
                    {EXPERIENCE_CATEGORY_LABELS[category]}
                  </span>
                  {timing && (
                    <span className="rounded-full bg-[var(--surface-container-high)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--on-surface-variant)]">
                      {timing}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-[var(--on-surface-variant)]">
                    {formatTimestamp(pulse.createdAt)}
                  </span>
                </div>
                <h4 className="truncate text-sm font-semibold text-[var(--on-surface)]">
                  {pulse.subject}
                </h4>
                <ExperienceBody body={pulse.body} />
                <p className="mt-2 text-[10px] text-[var(--on-surface-variant)]">
                  Posted by {posterName(pulse, agents)}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
