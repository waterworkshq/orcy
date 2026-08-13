import type { MissionComment, Pulse } from "../../types/index.js";

export type CommunicationKindFilter = "all" | "pulse" | "comment";

export type CommunicationFeedItem =
  | { kind: "pulse"; createdAt: string; pulse: Pulse }
  | { kind: "comment"; createdAt: string; comment: MissionComment };

export function mergeCommunicationFeed(
  pulses: Pulse[],
  comments: MissionComment[],
  options?: { kind?: CommunicationKindFilter },
): CommunicationFeedItem[] {
  const kind = options?.kind ?? "all";
  const items: CommunicationFeedItem[] = [];

  if (kind !== "comment") {
    for (const pulse of pulses) {
      items.push({ kind: "pulse", createdAt: pulse.createdAt, pulse });
    }
  }
  if (kind !== "pulse") {
    for (const comment of comments) {
      items.push({ kind: "comment", createdAt: comment.createdAt, comment });
    }
  }

  items.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    if (a.kind === b.kind) return 0;
    return a.kind === "pulse" ? -1 : 1;
  });

  return items;
}
