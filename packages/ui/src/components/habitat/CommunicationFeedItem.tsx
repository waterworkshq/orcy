import React from "react";
import { PulseSignalCard } from "./PulseSignalCard.js";
import { PulseReplyThread } from "./PulseReplyThread.js";
import { MissionCommentCard } from "./MissionCommentCard.js";
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

  return <MissionCommentCard missionId={missionId} comment={item.comment} />;
}
