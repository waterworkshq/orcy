import React, { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { useMissionPulseFeed } from "../../hooks/useMissionPulseFeed.js";
import { PulseFilterBar } from "./PulseFilterBar.js";
import { PulseTimeline } from "./PulseTimeline.js";
import { PulseComposeDialog } from "./PulseComposeDialog.js";
import type { SignalType } from "../../types/index.js";

interface PulseBoardProps {
  missionId: string;
}

export function PulseBoard({ missionId }: PulseBoardProps) {
  const [activeTypes, setActiveTypes] = useState<SignalType[]>([]);
  const [hideAuto, setHideAuto] = useState(false);
  const [showExperienceOverride, setShowExperienceOverride] = useState<boolean | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const { data: userData, isLoading: isUserLoading } = useQuery({
    queryKey: queryKeys.user.profile(),
    queryFn: () => api.auth.me(),
    staleTime: 5 * 60 * 1000,
  });
  const defaultShowExperience = userData?.user?.role !== "agent";
  const showExperience = showExperienceOverride ?? defaultShowExperience;

  const feed = useMissionPulseFeed(missionId, {
    activeTypes,
    hideAuto,
    showExperience,
    enabled: !isUserLoading,
  });

  const toggleType = useCallback((type: SignalType) => {
    setActiveTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }, []);

  const clearAll = useCallback(() => {
    setActiveTypes([]);
    setHideAuto(false);
    setShowExperienceOverride(null);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <p className="px-4 py-2 text-xs text-[var(--on-surface-variant)]">
        Pulse is a board shared by humans and agents.
      </p>
      <PulseFilterBar
        activeTypes={activeTypes}
        onToggleType={toggleType}
        hideAuto={hideAuto}
        onToggleHideAuto={() => {
          setHideAuto(!hideAuto);
        }}
        showExperience={showExperience}
        onToggleShowExperience={() => setShowExperienceOverride(!showExperience)}
        resultCount={feed.total}
        onClearAll={clearAll}
      />

      <div className="flex-1 overflow-y-auto">
        <PulseTimeline
          pulses={feed.pulses}
          isLoading={isUserLoading || feed.isLoading}
          missionId={missionId}
          hasMore={!!feed.hasNextPage}
          onLoadMore={() => feed.fetchNextPage()}
          loadingMore={feed.isFetchingNextPage}
        />
      </div>

      <div className="p-3 border-t border-[var(--outline-variant)] bg-[var(--surface-container)]/40 flex justify-end">
        <button
          onClick={() => setComposeOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold hover:opacity-90 transition-opacity"
        >
          <Plus className="h-4 w-4" />
          Post Signal
        </button>
      </div>

      <PulseComposeDialog
        missionId={missionId}
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
      />
    </div>
  );
}
