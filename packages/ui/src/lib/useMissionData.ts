import { useQuery } from '@tanstack/react-query';
import { api } from '../api/index.js';
import { queryKeys } from './queryKeys.js';

export function useFeatureDetails(featureId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.features.details(featureId ?? ''),
    queryFn: () => api.features.details(featureId!),
    enabled: !!featureId,
    staleTime: 30 * 1000,
  });
}
