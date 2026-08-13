import React, { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send } from "lucide-react";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { notify } from "../../lib/toast.js";
import { useMissionPulseFeed } from "../../hooks/useMissionPulseFeed.js";
import { useMissionComments } from "../../lib/useHabitatData.js";
import { Button } from "../ui/Button.js";
import { PulseFilterBar } from "./PulseFilterBar.js";
import { PulseComposeDialog } from "./PulseComposeDialog.js";
import { MergedFeed } from "./MergedFeed.js";
import {
  mergeCommunicationFeed,
  type CommunicationKindFilter,
} from "./mergeCommunicationFeed.js";
import type { SignalType } from "../../types/index.js";

interface MissionCommunicationBoardProps {
  missionId: string;
}

export function MissionCommunicationBoard({ missionId }: MissionCommunicationBoardProps) {
  const qc = useQueryClient();
  const [activeTypes, setActiveTypes] = useState<SignalType[]>([]);
  const [hideAuto, setHideAuto] = useState(true);
  const [showExperienceOverride, setShowExperienceOverride] = useState<boolean | null>(null);
  const [kind, setKind] = useState<CommunicationKindFilter>("all");
  const [composeOpen, setComposeOpen] = useState(false);
  const [commentContent, setCommentContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: userData, isLoading: isUserLoading } = useQuery({
    queryKey: queryKeys.user.profile(),
    queryFn: () => api.auth.me(),
    staleTime: 5 * 60 * 1000,
  });
  const defaultShowExperience = userData?.user?.role !== "agent";
  const showExperience = showExperienceOverride ?? defaultShowExperience;

  const pulseFeed = useMissionPulseFeed(missionId, {
    activeTypes,
    hideAuto,
    showExperience,
    enabled: !isUserLoading,
  });
  const commentsQuery = useMissionComments(missionId);
  const items = mergeCommunicationFeed(pulseFeed.pulses, commentsQuery.data?.comments ?? [], {
    kind,
  });

  const toggleType = useCallback((type: SignalType) => {
    setActiveTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }, []);

  async function handleComment() {
    if (!commentContent.trim() || kind === "pulse") return;
    setSubmitting(true);
    try {
      await api.missionComments.create(missionId, { content: commentContent.trim() });
      setCommentContent("");
      notify.success("Comment added");
      await qc.invalidateQueries({ queryKey: queryKeys.missionComments.list(missionId) });
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider">Communication</h3>
        <p className="mt-1 text-xs text-[var(--on-surface-variant)]">
          Pulse is shared memory for humans and agents. Comments are advisory feedback. They are
          listed together here; they are not the same thing.
        </p>
      </div>

      <div className="flex gap-1 px-4 pb-2">
        {(
          [
            ["all", "All"],
            ["pulse", "Pulse"],
            ["comment", "Comments"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setKind(value)}
            className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
              kind === value
                ? "bg-[var(--primary)] text-[var(--on-primary)]"
                : "bg-[var(--surface-container-high)] text-[var(--on-surface-variant)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {kind !== "comment" && (
        <PulseFilterBar
          activeTypes={activeTypes}
          onToggleType={toggleType}
          hideAuto={hideAuto}
          onToggleHideAuto={() => setHideAuto((prev) => !prev)}
          showExperience={showExperience}
          onToggleShowExperience={() => setShowExperienceOverride(!showExperience)}
          resultCount={pulseFeed.total}
          onClearAll={() => {
            setActiveTypes([]);
            setHideAuto(true);
            setShowExperienceOverride(null);
          }}
          defaultHideAuto
        />
      )}

      <div className="flex-1 overflow-y-auto">
        <MergedFeed
          items={items}
          isLoading={isUserLoading || pulseFeed.isLoading || commentsQuery.isLoading}
          missionId={missionId}
          hasMore={kind !== "comment" && !!pulseFeed.hasNextPage}
          onLoadMore={() => pulseFeed.fetchNextPage()}
          loadingMore={pulseFeed.isFetchingNextPage}
          emptyTitle="No Pulse signals or comments yet"
        />
      </div>

      <div className="space-y-2 border-t border-[var(--outline-variant)] bg-[var(--surface-container)]/40 p-3">
        {kind !== "pulse" && (
          <textarea
            value={commentContent}
            onChange={(e) => setCommentContent(e.target.value)}
            placeholder="Add a comment about this mission..."
            rows={2}
            className="w-full resize-none rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container-high)] p-2 text-sm"
            disabled={submitting}
          />
        )}
        <div className="flex justify-end gap-2">
          {kind !== "pulse" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleComment}
              disabled={submitting || !commentContent.trim()}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Post comment
            </Button>
          )}
          {kind !== "comment" && (
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--on-primary)]"
            >
              <Plus className="h-4 w-4" />
              Post Signal
            </button>
          )}
        </div>
      </div>

      <PulseComposeDialog
        missionId={missionId}
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
      />
    </div>
  );
}
