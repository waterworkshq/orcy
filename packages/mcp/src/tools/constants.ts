export const PRIORITY_LEVELS = ["low", "medium", "high", "critical"] as const;
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
export const FEATURE_STATUSES = ["not_started", "in_progress", "review", "done", "failed"] as const;
export const AGENT_STATUSES = ["idle", "working", "offline"] as const;
export const AGENT_TYPES = ["claude-code", "codex", "opencode", "cursor", "gemini"] as const;
export const ARTIFACT_TYPES = ["file", "pr", "commit", "log", "screenshot"] as const;
export const MESSAGE_TYPES = ["info", "request", "response", "alert"] as const;
export const MESSAGE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const WEBHOOK_FORMATS = ["standard", "slack", "discord"] as const;
export const TIME_RANGES = ["24h", "7d", "30d", "all"] as const;

export const ARTIFACT_SCHEMA_FRAGMENT = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...ARTIFACT_TYPES] },
    url: { type: "string" },
    description: { type: "string" },
  },
  required: ["type", "url", "description"],
} as const;

export const TASK_UPDATE_STATUSES = [
  "in_progress",
  "submitted",
  "approved",
  "done",
  "failed",
] as const;
