import React, { useState, useCallback } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { PulseFilterBar } from "./PulseFilterBar.js";
import { PulseTimeline } from "./PulseTimeline.js";
import { PulseComposeDialog } from "./PulseComposeDialog.js";
import { SIGNAL_TYPES } from "../../lib/signalConfig.js";
import type { SignalType } from "../../types/index.js";

const PAGE_SIZE = 20;

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

  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage } = useInfiniteQuery({
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
      if (hideAuto) {
        params.isAuto = "false";
      }
      return api.pulse.listByMission(missionId, params);
    },
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage || !lastPage.items) return undefined;
      return lastPage.items.length < PAGE_SIZE ? undefined : allPages.length;
    },
    enabled: !isUserLoading,
    staleTime: 15 * 1000,
  });

  const pulses = data?.pages.flatMap((page) => page.items) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  const hasMore = hasNextPage;

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
      <PulseFilterBar
        activeTypes={activeTypes}
        onToggleType={toggleType}
        hideAuto={hideAuto}
        onToggleHideAuto={() => {
          setHideAuto(!hideAuto);
        }}
        showExperience={showExperience}
        onToggleShowExperience={() => setShowExperienceOverride(!showExperience)}
        resultCount={total}
        onClearAll={clearAll}
      />

      <div className="flex-1 overflow-y-auto">
        <PulseTimeline
          pulses={pulses}
          isLoading={isUserLoading || isLoading}
          missionId={missionId}
          hasMore={hasMore}
          onLoadMore={() => fetchNextPage()}
          loadingMore={isFetchingNextPage}
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
