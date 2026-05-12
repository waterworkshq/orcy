import React, { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../api/index.js';
import { useBoardStore } from '../../store/habitatStore.js';
import { PulseFilterBar } from './PulseFilterBar.js';
import { PulseTimeline } from './PulseTimeline.js';
import { PulseComposeDialog } from './PulseComposeDialog.js';
import type { SignalType, SSEEvent } from '../../types/index.js';

const PAGE_SIZE = 20;

interface PulseBoardProps {
  missionId: string;
}

export function PulseBoard({ missionId }: PulseBoardProps) {
  const queryClient = useQueryClient();
  const [activeTypes, setActiveTypes] = useState<SignalType[]>([]);
  const [hideAuto, setHideAuto] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [page, setPage] = useState(0);
  const handleSSEEvent = useBoardStore((s) => s.handleSSEEvent);

  const queryKey = ['pulses', missionId, { activeTypes, hideAuto, page }];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => {
      const params: Record<string, string | number> = {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      };
      if (activeTypes.length > 0) {
        params.signalTypes = activeTypes.join(',');
      }
      if (hideAuto) {
        params.isAuto = 'false';
      }
      return api.pulse.listByMission(missionId, params);
    },
    staleTime: 15 * 1000,
  });

  const pulses = data?.pulses ?? [];
  const total = data?.total ?? 0;
  const hasMore = pulses.length < total;

  React.useEffect(() => {
    function handleSSE(e: MessageEvent) {
      try {
        const event = JSON.parse(e.data) as SSEEvent;
        if (event.type === 'pulse.signal_posted') {
          handleSSEEvent(event);
          queryClient.invalidateQueries({ queryKey: ['pulses', missionId] });
        }
      } catch {}
    }

    const boardId = pulses[0]?.boardId;
    if (!boardId) return;

    const es = new EventSource(`/sse/boards/${boardId}/stream`);
    es.addEventListener('message', handleSSE);
    return () => {
      es.removeEventListener('message', handleSSE);
      es.close();
    };
  }, [missionId, pulses, queryClient, handleSSEEvent]);

  const toggleType = useCallback((type: SignalType) => {
    setActiveTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
    setPage(0);
  }, []);

  const clearAll = useCallback(() => {
    setActiveTypes([]);
    setHideAuto(false);
    setPage(0);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <PulseFilterBar
        activeTypes={activeTypes}
        onToggleType={toggleType}
        hideAuto={hideAuto}
        onToggleHideAuto={() => { setHideAuto(!hideAuto); setPage(0); }}
        resultCount={total}
        onClearAll={clearAll}
      />

      <div className="flex-1 overflow-y-auto">
        <PulseTimeline
          pulses={pulses}
          isLoading={isLoading}
          missionId={missionId}
          hasMore={hasMore}
          onLoadMore={() => setPage((p) => p + 1)}
          loadingMore={false}
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
