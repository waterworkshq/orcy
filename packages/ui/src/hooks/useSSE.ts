import { useEffect, useRef, useCallback } from "react";
import { useHabitatStore } from "../store/habitatStore.js";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateSSEEventCache } from "../sse/registry.js";
import type { SSEEvent } from "../types/index.js";

export function useSSE(boardId: string) {
  const handleSSEEvent = useHabitatStore((s) => s.handleSSEEvent);
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);

  const invalidateCache = useCallback(
    (event: SSEEvent) => {
      invalidateSSEEventCache(event, queryClient, boardId, () => useHabitatStore.getState());
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
