import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys.js';
import { api } from '../../api/index.js';
import { Timer } from 'lucide-react';
import type { Sprint } from '../../types/index.js';

interface SprintSelectorProps {
  habitatId: string;
  onOpenPlanning: () => void;
}

export function SprintSelector({ habitatId, onOpenPlanning }: SprintSelectorProps) {
  const { data } = useQuery({
    queryKey: queryKeys.sprints.active(habitatId),
    queryFn: () => api.sprints.getActive(habitatId),
    enabled: !!habitatId,
    staleTime: 30_000,
  });

  const sprint = data?.sprint;

  const daysRemaining = useMemo(() => {
    if (!sprint) return 0;
    const daysTotal = Math.ceil((new Date(sprint.endDate).getTime() - new Date(sprint.startDate).getTime()) / (1000 * 60 * 60 * 24));
    const daysElapsed = Math.floor((Date.now() - new Date(sprint.startDate).getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, daysTotal - daysElapsed);
  }, [sprint]);

  if (!sprint) {
    return (
      <button
        type="button"
        onClick={onOpenPlanning}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high transition-colors"
      >
        <Timer className="h-3.5 w-3.5" />
        <span>No active sprint</span>
      </button>
    );
  }

  const daysLeft = daysRemaining;

  return (
    <button
      type="button"
      onClick={onOpenPlanning}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-surface-container-high"
    >
      <Timer className={`h-3.5 w-3.5 ${sprint.status === 'active' ? 'text-green-500' : 'text-amber-500'}`} />
      <span className="font-medium text-on-surface truncate max-w-[120px]">{sprint.name}</span>
      {sprint.status === 'active' && (
        <span className={`text-[10px] ${daysLeft <= 1 ? 'text-red-500 font-bold' : daysLeft <= 3 ? 'text-amber-500' : 'text-on-surface-variant'}`}>
          {daysLeft}d left
        </span>
      )}
    </button>
  );
}

export function useActiveSprint(habitatId: string): Sprint | null | undefined {
  const { data } = useQuery({
    queryKey: queryKeys.sprints.active(habitatId),
    queryFn: () => api.sprints.getActive(habitatId),
    enabled: !!habitatId,
    staleTime: 30_000,
  });
  return data?.sprint;
}
