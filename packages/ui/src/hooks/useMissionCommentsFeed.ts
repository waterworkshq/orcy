import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api/index.js";
import { queryKeys } from "../lib/queryKeys.js";

export const MISSION_COMMENTS_PAGE_SIZE = 50;

export function useMissionCommentsFeed(
  missionId: string,
  options?: {
    enabled?: boolean;
  },
) {
  const query = useInfiniteQuery({
    initialPageParam: 0,
    queryKey: queryKeys.missionComments.list(missionId),
    queryFn: ({ pageParam = 0 }) =>
      api.missionComments.list(missionId, {
        limit: MISSION_COMMENTS_PAGE_SIZE,
        offset: (pageParam as number) * MISSION_COMMENTS_PAGE_SIZE,
      }),
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage || !lastPage.comments) return undefined;
      return lastPage.comments.length < MISSION_COMMENTS_PAGE_SIZE ? undefined : allPages.length;
    },
    enabled: options?.enabled ?? (!!missionId),
    staleTime: 30 * 1000,
  });

  const comments = query.data?.pages.flatMap((page) => page.comments) ?? [];
  const total = query.data?.pages[0]?.total ?? comments.length;

  return {
    comments,
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
