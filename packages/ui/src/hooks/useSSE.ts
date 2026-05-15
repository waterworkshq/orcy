import { useEffect, useRef, useCallback } from 'react';
import { useBoardStore } from '../store/habitatStore.js';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import type { SSEEvent } from '../types/index.js';

export function useSSE(boardId: string) {
  const handleSSEEvent = useBoardStore((s) => s.handleSSEEvent);
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);

  const invalidateCache = useCallback((event: SSEEvent) => {
    const qc = queryClient;
    const taskId = 'taskId' in event.data ? event.data.taskId : 'id' in event.data ? event.data.id : null;
    const agentId = 'agentId' in event.data ? event.data.agentId : null;

    switch (event.type as string) {
      case 'task.commented':
      case 'task.comment_deleted':
        if (taskId) {
          qc.invalidateQueries({ queryKey: queryKeys.tasks.comments(taskId) });
        }
        break;
      case 'board.updated':
        qc.invalidateQueries({ queryKey: queryKeys.boards.detail(boardId) });
        qc.invalidateQueries({ queryKey: queryKeys.boards.list() });
        break;
      case 'column.created':
      case 'column.updated':
      case 'column.deleted':
        qc.invalidateQueries({ queryKey: queryKeys.boards.detail(boardId) });
        break;
      case 'agent.status_changed':
      case 'agent.heartbeat':
        if (agentId) {
          qc.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
        }
        qc.invalidateQueries({ queryKey: queryKeys.agents.list() });
        break;
      case 'feature.created':
      case 'feature.updated':
      case 'feature.moved':
      case 'feature.status_changed':
      case 'feature.deleted':
        qc.invalidateQueries({ queryKey: queryKeys.features.list(boardId) });
        if ('id' in event.data && event.data.id) {
          qc.invalidateQueries({ queryKey: queryKeys.features.detail((event.data as { id: string }).id) });
          qc.invalidateQueries({ queryKey: queryKeys.features.details((event.data as { id: string }).id) });
        }
        if ('featureId' in event.data) {
          qc.invalidateQueries({ queryKey: queryKeys.features.progress((event.data as { featureId: string }).featureId) });
        }
        break;
      case 'feature.progress':
        if ('featureId' in event.data) {
          const featureId = (event.data as { featureId: string }).featureId;
          qc.invalidateQueries({ queryKey: queryKeys.features.detail(featureId) });
          qc.invalidateQueries({ queryKey: queryKeys.features.progress(featureId) });
        }
        break;
      case 'task.created':
      case 'task.updated':
      case 'task.deleted':
      case 'task.moved':
      case 'task.claimed':
      case 'task.started':
      case 'task.submitted':
      case 'task.approved':
      case 'task.rejected':
      case 'task.completed':
      case 'task.failed':
      case 'task.released':
      case 'task.delegated':
      case 'task.overdue':
        if (taskId) {
          qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
          qc.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
          qc.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
          const task = useBoardStore.getState().tasks.find(t => t.id === taskId);
          if (task?.featureId) {
            qc.invalidateQueries({ queryKey: queryKeys.features.progress(task.featureId) });
            qc.invalidateQueries({ queryKey: queryKeys.features.detail(task.featureId) });
          }
        }
        qc.invalidateQueries({ queryKey: queryKeys.boards.detail(boardId) });
        break;
      case 'pulse.signal_posted':
        qc.invalidateQueries({ queryKey: queryKeys.pulse.byBoard(boardId) });
        qc.invalidateQueries({ queryKey: queryKeys.insights.byBoard(boardId) });
        break;
    }
  }, [boardId, queryClient]);

  const connect = useCallback(async () => {
    if (esRef.current) {
      esRef.current.close();
    }

    let streamUrl = `/sse/boards/${boardId}/stream`;

    const token = localStorage.getItem('orcy_token');
    if (token) {
      try {
        const res = await fetch('/api/auth/stream-token', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          streamUrl = `/sse/boards/${boardId}/stream?token=${encodeURIComponent(data.token)}`;
        }
      } catch {
        // Fall through to unauthenticated connection
      }
    }

    const es = new EventSource(streamUrl);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as SSEEvent;
        handleSSEEvent(event);
        invalidateCache(event);
        retryDelayRef.current = 1000;
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      reconnectTimeoutRef.current = setTimeout(() => {
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, 30000);
        connect();
      }, retryDelayRef.current);
    };
  }, [boardId, handleSSEEvent, invalidateCache]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      esRef.current?.close();
    };
  }, [connect]);
}
