import { useEffect, useRef, useCallback } from "react";
import { useHabitatStore } from "../store/habitatStore.js";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys.js";
import type { SSEEvent } from "../types/index.js";

export function useSSE(boardId: string) {
  const handleSSEEvent = useHabitatStore((s) => s.handleSSEEvent);
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);

  const invalidateCache = useCallback(
    (event: SSEEvent) => {
      const qc = queryClient;
      const taskId =
        "taskId" in event.data ? event.data.taskId : "id" in event.data ? event.data.id : null;
      const agentId = "agentId" in event.data ? event.data.agentId : null;

      switch (event.type as string) {
        case "task.commented":
        case "task.comment_deleted":
          if (taskId) {
            qc.invalidateQueries({ queryKey: queryKeys.tasks.comments(taskId) });
          }
          break;
        case "habitat.updated":
          qc.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
          qc.invalidateQueries({ queryKey: queryKeys.habitats.list() });
          break;
        case "column.created":
        case "column.updated":
        case "column.deleted":
          qc.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
          break;
        case "agent.status_changed":
        case "agent.heartbeat":
          if (agentId) {
            qc.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
          }
          qc.invalidateQueries({ queryKey: queryKeys.agents.list() });
          qc.invalidateQueries({ queryKey: queryKeys.agents.listWithTasks() });
          break;
        case "mission.created":
        case "mission.updated":
        case "mission.moved":
        case "mission.status_changed":
        case "mission.deleted":
          qc.invalidateQueries({ queryKey: queryKeys.missions.list(boardId) });
          if ("id" in event.data && event.data.id) {
            qc.invalidateQueries({
              queryKey: queryKeys.missions.detail((event.data as { id: string }).id),
            });
            qc.invalidateQueries({
              queryKey: queryKeys.missions.details((event.data as { id: string }).id),
            });
          }
          if ("missionId" in event.data) {
            qc.invalidateQueries({
              queryKey: queryKeys.missions.progress(
                (event.data as { missionId: string }).missionId,
              ),
            });
          }
          break;
        case "mission.progress":
          if ("missionId" in event.data) {
            const missionId = (event.data as { missionId: string }).missionId;
            qc.invalidateQueries({ queryKey: queryKeys.missions.detail(missionId) });
            qc.invalidateQueries({ queryKey: queryKeys.missions.progress(missionId) });
          }
          break;
        case "task.created":
        case "task.updated":
        case "task.deleted":
        case "task.moved":
        case "task.claimed":
        case "task.started":
        case "task.submitted":
        case "task.approved":
        case "task.rejected":
        case "task.completed":
        case "task.failed":
        case "task.released":
        case "task.delegated":
        case "task.overdue":
          if (taskId) {
            qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
            qc.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
            qc.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
            const task = useHabitatStore.getState().tasks.find((t) => t.id === taskId);
            if (task?.missionId) {
              qc.invalidateQueries({ queryKey: queryKeys.missions.progress(task.missionId) });
              qc.invalidateQueries({ queryKey: queryKeys.missions.detail(task.missionId) });
            }
          }
          qc.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
          break;
        case "pulse.signal_posted":
          qc.invalidateQueries({ queryKey: queryKeys.pulse.byBoard(boardId) });
          qc.invalidateQueries({ queryKey: queryKeys.insights.byBoard(boardId) });
          break;
        case "task.review_assigned":
        case "task.review_completed":
          if (taskId) {
            qc.invalidateQueries({ queryKey: queryKeys.tasks.reviewers(taskId) });
          }
          if (event.type === "task.review_completed" && taskId) {
            qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
            qc.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
            qc.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
            qc.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
          }
          break;
        case "task.priority_changed":
          if (taskId) {
            qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
            qc.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
            qc.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
          }
          qc.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
          break;
        case "sprint.created":
        case "sprint.started":
        case "sprint.completed":
          qc.invalidateQueries({ queryKey: queryKeys.sprints.list(boardId) });
          qc.invalidateQueries({ queryKey: queryKeys.sprints.active(boardId) });
          qc.invalidateQueries({ queryKey: queryKeys.missions.list(boardId) });
          qc.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
          if ("sprintId" in event.data) {
            qc.invalidateQueries({
              queryKey: queryKeys.sprints.detail((event.data as { sprintId: string }).sprintId),
            });
          }
          break;
      }
    },
    [boardId, queryClient],
  );

  const connect = useCallback(async () => {
    if (esRef.current) {
      esRef.current.close();
    }

    let streamUrl = `/sse/habitats/${boardId}/stream`;

    const token = localStorage.getItem("orcy_token");
    if (token) {
      try {
        const res = await fetch("/api/auth/stream-token", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          streamUrl = `/sse/habitats/${boardId}/stream?token=${encodeURIComponent(data.token)}`;
        }
      } catch {
        // Fall through to unauthenticated connection
      }
    }

    const es = new EventSource(streamUrl);
    esRef.current = es;

    es.addEventListener("message", (e) => {
      try {
        const event = JSON.parse(e.data) as SSEEvent;
        handleSSEEvent(event);
        invalidateCache(event);
        retryDelayRef.current = 1000;
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("error", () => {
      es.close();
      esRef.current = null;
      reconnectTimeoutRef.current = setTimeout(() => {
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, 30000);
        connect();
      }, retryDelayRef.current);
    });
  }, [boardId, handleSSEEvent, invalidateCache]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      esRef.current?.close();
    };
  }, [connect]);
}
