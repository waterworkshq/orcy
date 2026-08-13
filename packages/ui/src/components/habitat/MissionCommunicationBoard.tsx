import React, { useCallback, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send } from "lucide-react";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { notify } from "../../lib/toast.js";
import { formatRelativeTime } from "../../lib/formatting.js";
import { SIGNAL_TYPES } from "../../lib/signalConfig.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import { Button } from "../ui/Button.js";
import { PulseFilterBar } from "./PulseFilterBar.js";
import { PulseSignalCard } from "./PulseSignalCard.js";
import { PulseReplyThread } from "./PulseReplyThread.js";
import { PulseComposeDialog } from "./PulseComposeDialog.js";
import { MissionCommentSection } from "./MissionCommentSection.js";
import {
  mergeCommunicationFeed,
  type CommunicationKindFilter,
} from "./mergeCommunicationFeed.js";
import type { SignalType } from "../../types/index.js";

const PAGE_SIZE = 20;

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

  const pulseQuery = useInfiniteQuery({
    initialPageParam: 0,
    queryKey: [...queryKeys.pulse.byMission(missionId), { activeTypes, hideAuto, showExperience }],
    queryFn: ({ pageParam = 0 }) => {
      const params: Record<string, string | number> = {
        limit: PAGE_SIZE,
        offset: (pageParam as number) * PAGE_SIZE,
      };
      const filteredTypes = activeTypes.filter((type) => showExperience || type !== "experience");
      if (filteredTypes.length > 0) {
        params.signalTypes = filteredTypes.join(",");
      } else if (!showExperience) {
        params.signalTypes = SIGNAL_TYPES.filter((type) => type !== "experience").join(",");
      }
      if (hideAuto) params.isAuto = "false";
      return api.pulse.listByMission(missionId, params);
    },
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage || !lastPage.items) return undefined;
      return lastPage.items.length < PAGE_SIZE ? undefined : allPages.length;
    },
    enabled: !isUserLoading,
    staleTime: 15 * 1000,
  });

  const commentsQuery = useQuery({
    queryKey: queryKeys.missionComments.list(missionId),
    queryFn: () => api.missionComments.list(missionId),
    staleTime: 30 * 1000,
  });

  const pulses = pulseQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const comments = commentsQuery.data?.comments ?? [];
  const items = mergeCommunicationFeed(pulses, comments, { kind });
  const pulseTotal = pulseQuery.data?.pages[0]?.total ?? 0;

  const toggleType = useCallback((type: SignalType) => {
    setActiveTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }, []);

  async function handleComment() {
    if (!commentContent.trim()) return;
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

      <PulseFilterBar
        activeTypes={activeTypes}
        onToggleType={toggleType}
        hideAuto={hideAuto}
        onToggleHideAuto={() => setHideAuto((prev) => !prev)}
        showExperience={showExperience}
        onToggleShowExperience={() => setShowExperienceOverride(!showExperience)}
        resultCount={pulseTotal}
        onClearAll={() => {
          setActiveTypes([]);
          setHideAuto(true);
          setShowExperienceOverride(null);
        }}
        defaultHideAuto
      />

      <div className="flex-1 overflow-y-auto">
        {kind === "comment" ? (
          <MissionCommentSection missionId={missionId} />
        ) : pulseQuery.isLoading || commentsQuery.isLoading || isUserLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-lg bg-[var(--surface-container-high)]"
              />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-12 text-center text-sm text-[var(--on-surface-variant)]">
            No Pulse signals or comments yet
          </p>
        ) : (
          <div className="space-y-3 p-4">
            {items.map((item) =>
              item.kind === "pulse" ? (
                <div key={`pulse:${item.pulse.id}`} className="space-y-1">
                  <PulseSignalCard pulse={item.pulse} missionId={missionId} />
                  {!item.pulse.replyToId && (
                    <PulseReplyThread pulse={item.pulse} missionId={missionId} />
                  )}
                </div>
              ) : (
                <article
                  key={`comment:${item.comment.id}`}
                  className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)] p-3"
                >
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--on-surface-variant)]">
                    Comment
                  </p>
                  <p className="text-[10px] text-[var(--on-surface-variant)]">
                    {item.comment.authorType === "agent" ? "Agent" : "Human"} ·{" "}
                    {formatRelativeTime(item.comment.createdAt, { fallbackToDate: true })}
                  </p>
                  <div className="prose prose-sm mt-2 max-w-none text-[var(--on-surface-variant)]">
                    <MarkdownContent content={item.comment.content} />
                  </div>
                </article>
              ),
            )}
            {pulseQuery.hasNextPage && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => pulseQuery.fetchNextPage()}
                  disabled={pulseQuery.isFetchingNextPage}
                  className="rounded-lg border border-[var(--outline-variant)] px-4 py-2 text-xs"
                >
                  {pulseQuery.isFetchingNextPage ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {kind !== "comment" && (
      <div className="space-y-2 border-t border-[var(--outline-variant)] bg-[var(--surface-container)]/40 p-3">
        <textarea
          value={commentContent}
          onChange={(e) => setCommentContent(e.target.value)}
          placeholder="Add a comment about this mission..."
          rows={2}
          className="w-full resize-none rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container-high)] p-2 text-sm"
          disabled={submitting}
        />
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleComment}
            disabled={submitting || !commentContent.trim()}
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            Post comment
          </Button>
          <button
            type="button"
            onClick={() => setComposeOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-semibold text-[var(--on-primary)]"
          >
            <Plus className="h-4 w-4" />
            Post Signal
          </button>
        </div>
      </div>
      )}

      <PulseComposeDialog
        missionId={missionId}
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
      />
    </div>
  );
}
