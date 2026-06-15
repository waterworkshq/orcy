/** Maps webhook event types to the emoji shown in formatted notification titles. */
export const EVENT_EMOJI_MAP: Record<string, string> = {
  "task.created": "🆕",
  "task.claimed": "🤚",
  "task.submitted": "📨",
  "task.approved": "✅",
  "task.rejected": "❌",
  "task.completed": "🎉",
  "task.failed": "⚠️",
  "task.released": "🔓",
  "agent.status_changed": "🤖",
  "column.wip_limit_reached": "🚧",
};

/** Converts a dot-separated webhook event type into a human-readable title. */
export function formatEventTitle(eventType: string): string {
  return eventType
    .replace(".", " ")
    .replace("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
