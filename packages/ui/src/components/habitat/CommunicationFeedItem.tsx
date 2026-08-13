import React from "react";
import { PulseSignalCard } from "./PulseSignalCard.js";
import { PulseReplyThread } from "./PulseReplyThread.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import { formatRelativeTime } from "../../lib/formatting.js";
import { missionCommentAuthorLabel } from "./missionCommentAuthor.js";
import type { CommunicationFeedItem } from "./mergeCommunicationFeed.js";

interface CommunicationFeedItemViewProps {
  item: CommunicationFeedItem;
  missionId: string;
}

export function CommunicationFeedItemView({ item, missionId }: CommunicationFeedItemViewProps) {
  if (item.kind === "pulse") {
    return (
      <div className="space-y-1">
        <PulseSignalCard pulse={item.pulse} missionId={missionId} />
        {!item.pulse.replyToId && <PulseReplyThread pulse={item.pulse} missionId={missionId} />}
      </div>
    );
  }

  return (
    <article className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)] p-3">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--on-surface-variant)]">
        Comment
      </p>
      <p className="text-[10px] text-[var(--on-surface-variant)]">
        {missionCommentAuthorLabel(item.comment)} ·{" "}
        {formatRelativeTime(item.comment.createdAt, { fallbackToDate: true })}
      </p>
      <div className="prose prose-sm mt-2 max-w-none text-[var(--on-surface-variant)]">
        <MarkdownContent content={item.comment.content} />
      </div>
    </article>
  );
}
