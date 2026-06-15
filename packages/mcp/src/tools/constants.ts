/** Exhaustive list of every supported {@link TaskPriority} level. */
export const PRIORITY_LEVELS = ["low", "medium", "high", "critical"] as const;

/** Exhaustive list of every supported {@link TaskStatus} value. */
export const TASK_STATUSES = [
  "pending",
  "claimed",
  "in_progress",
  "submitted",
  "approved",
  "rejected",
  "done",
  "failed",
] as const;

/** Exhaustive list of every supported {@link MissionStatus} value. */
export const FEATURE_STATUSES = ["not_started", "in_progress", "review", "done", "failed"] as const;

/** Exhaustive list of every supported {@link AgentStatus} value. */
export const AGENT_STATUSES = ["idle", "working", "offline"] as const;

/** Exhaustive list of every supported {@link AgentType}. */
export const AGENT_TYPES = ["claude-code", "codex", "opencode", "cursor", "gemini"] as const;

/** Exhaustive list of every supported {@link Artifact} kind. */
export const ARTIFACT_TYPES = ["file", "pr", "commit", "log", "screenshot"] as const;

/** Exhaustive list of message kinds exchanged between agents. */
export const MESSAGE_TYPES = ["info", "request", "response", "alert"] as const;

/** Exhaustive list of message priority levels. */
export const MESSAGE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/** Exhaustive list of supported {@link WebhookSubscription} payload formats. */
export const WEBHOOK_FORMATS = ["standard", "slack", "discord"] as const;

/** Exhaustive list of selectable time ranges for stats and metrics queries. */
export const TIME_RANGES = ["24h", "7d", "30d", "all"] as const;

/** Reusable JSON-schema fragment describing an {@link Artifact} link. */
export const ARTIFACT_SCHEMA_FRAGMENT = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...ARTIFACT_TYPES] },
    url: { type: "string" },
    description: { type: "string" },
  },
  required: ["type", "url", "description"],
} as const;

/** Subset of {@link TaskStatus} values an agent may write via the update action. */
export const TASK_UPDATE_STATUSES = [
  "in_progress",
  "submitted",
  "approved",
  "done",
  "failed",
] as const;
