import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api/index.js";
import { queryKeys } from "../lib/queryKeys.js";
import { SIGNAL_TYPES } from "../lib/signalConfig.js";
import type { SignalType } from "../types/index.js";

export const MISSION_PULSE_PAGE_SIZE = 20;

export function buildMissionPulseListParams(input: {
  pageParam: number;
  activeTypes: SignalType[];
  hideAuto: boolean;
  showExperience: boolean;
}): Record<string, string | number> {
  const params: Record<string, string | number> = {
    limit: MISSION_PULSE_PAGE_SIZE,
    offset: input.pageParam * MISSION_PULSE_PAGE_SIZE,
  };
  const filteredTypes = input.activeTypes.filter(
    (type) => input.showExperience || type !== "experience",
  );
  if (filteredTypes.length > 0) {
    params.signalTypes = filteredTypes.join(",");
  } else if (!input.showExperience) {
    params.signalTypes = SIGNAL_TYPES.filter((type) => type !== "experience").join(",");
  }
  if (input.hideAuto) {
    params.isAuto = "false";
  }
  return params;
}

export function useMissionPulseFeed(
  missionId: string,
  input: {
    activeTypes: SignalType[];
    hideAuto: boolean;
    showExperience: boolean;
    enabled?: boolean;
  },
) {
  const query = useInfiniteQuery({
    initialPageParam: 0,
    queryKey: [
      ...queryKeys.pulse.byMission(missionId),
      { activeTypes: input.activeTypes, hideAuto: input.hideAuto, showExperience: input.showExperience },
    ],
    queryFn: ({ pageParam = 0 }) =>
      api.pulse.listByMission(
        missionId,
        buildMissionPulseListParams({
          pageParam: pageParam as number,
          activeTypes: input.activeTypes,
          hideAuto: input.hideAuto,
          showExperience: input.showExperience,
        }),
      ),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage || !lastPage.items) return undefined;
      return lastPage.items.length < MISSION_PULSE_PAGE_SIZE ? undefined : allPages.length;
    },
    enabled: input.enabled ?? true,
    staleTime: 15 * 1000,
  });

  const pulses = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  return {
    pulses,
    total,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
