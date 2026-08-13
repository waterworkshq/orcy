import React from "react";
import { mergeCommunicationFeed } from "./mergeCommunicationFeed.js";
import { MergedFeed } from "./MergedFeed.js";
import type { Pulse } from "../../types/index.js";

interface PulseTimelineProps {
  pulses: Pulse[];
  isLoading: boolean;
  missionId: string;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
}

/** Pulse-only list chrome. Rendering lives in MergedFeed + CommunicationFeedItem. */
export function PulseTimeline({
  pulses,
  isLoading,
  missionId,
  hasMore,
  onLoadMore,
  loadingMore,
}: PulseTimelineProps) {
  return (
    <MergedFeed
      items={mergeCommunicationFeed(pulses, [], { kind: "pulse" })}
      isLoading={isLoading}
      missionId={missionId}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      loadingMore={loadingMore}
      emptyTitle="No signals yet"
      emptyHint="Post a signal to start the conversation"
    />
  );
}
