/** Exhaustive readonly list of recognised pulse signal categories, including the v0.20 experience self-reporting type. */
export const SIGNAL_TYPES = [
  "finding",
  "blocker",
  "offer",
  "warning",
  "question",
  "answer",
  "directive",
  "context",
  "handoff",
  "experience",
] as const;

/** Union of the members of {@link SIGNAL_TYPES}, representing a categorised inter-agent signal. */
export type SignalType = (typeof SIGNAL_TYPES)[number];
