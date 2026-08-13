import React from "react";
import { Radio } from "lucide-react";
import { CommunicationFeedItemView } from "./CommunicationFeedItem.js";
import type { CommunicationFeedItem } from "./mergeCommunicationFeed.js";

interface MergedFeedProps {
  items: CommunicationFeedItem[];
  isLoading: boolean;
  missionId: string;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
  emptyTitle: string;
  emptyHint?: string;
}

export function MergedFeed({
  items,
  isLoading,
  missionId,
  hasMore,
  onLoadMore,
  loadingMore,
  emptyTitle,
  emptyHint,
}: MergedFeedProps) {
  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="space-y-2 rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)]/60 p-3 animate-pulse"
          >
            <div className="flex gap-2">
              <div className="h-4 w-16 rounded bg-[var(--surface-container-high)]" />
              <div className="h-4 w-20 rounded bg-[var(--surface-container-high)]" />
            </div>
            <div className="h-4 w-3/4 rounded bg-[var(--surface-container-high)]" />
            <div className="h-3 w-1/2 rounded bg-[var(--surface-container-high)]" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-[var(--on-surface-variant)]">
        <Radio className="h-10 w-10 opacity-30" />
        <p className="text-sm">{emptyTitle}</p>
        {emptyHint ? <p className="text-[11px] opacity-60">{emptyHint}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      {items.map((item) => (
        <CommunicationFeedItemView
          key={item.kind === "pulse" ? `pulse:${item.pulse.id}` : `comment:${item.comment.id}`}
          item={item}
          missionId={missionId}
        />
      ))}
      {hasMore && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)] px-4 py-2 text-xs font-medium text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)] disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
