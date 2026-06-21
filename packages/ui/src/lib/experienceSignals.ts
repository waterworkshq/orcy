import type { ExperienceCategory, Pulse } from "../types/index.js";

/** The current self-reporting experience categories in display order. */
export const EXPERIENCE_CATEGORY_ORDER: ExperienceCategory[] = [
  "stuck",
  "confused",
  "backtrack",
  "surprised",
  "ambiguous",
  "sidetracked",
  "smooth",
];

/** Human-readable labels for agent experience categories. */
export const EXPERIENCE_CATEGORY_LABELS: Record<ExperienceCategory, string> = {
  stuck: "stuck",
  confused: "confused",
  backtrack: "backtrack",
  surprised: "surprised",
  ambiguous: "ambiguous",
  sidetracked: "sidetracked",
  smooth: "smooth",
};

/** Badge classes for experience category display semantics. */
export const EXPERIENCE_CATEGORY_BADGES: Record<ExperienceCategory, string> = {
  stuck: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  confused: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  backtrack: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  surprised: "bg-slate-500/15 text-slate-600 border-slate-500/30",
  ambiguous: "bg-slate-500/15 text-slate-600 border-slate-500/30",
  sidetracked: "bg-orange-500/15 text-orange-700 border-orange-500/30",
  smooth: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
};

/** Reads and validates the experience category stored in a pulse metadata payload. */
export function getExperienceCategory(pulse: Pulse): ExperienceCategory | null {
  const value = pulse.metadata?.experience;
  return typeof value === "string" && value in EXPERIENCE_CATEGORY_LABELS
    ? (value as ExperienceCategory)
    : null;
}

/** Formats the timing metadata stamped by experience self-reporting tools. */
export function formatExperienceTiming(pulse: Pulse): string | null {
  const value = pulse.metadata?.timing;
  if (value === "mid_task") return "mid-task";
  if (value === "completion") return "completion";
  return typeof value === "string" ? value.replace(/_/g, "-") : null;
}
