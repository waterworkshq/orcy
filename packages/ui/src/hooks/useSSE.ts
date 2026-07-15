import { useEffect, useRef, useCallback } from "react";
import { useHabitatStore } from "../store/habitatStore.js";
import { useQueryClient } from "@tanstack/react-query";
import { projectSSEServerEvent } from "../sse/registry.js";
import type { SSEEvent } from "../types/index.js";

/**
 * Subscribes to a Habitat's SSE stream and projects each event exactly once.
 *
 * Connection lifecycle is generation-guarded and abortable:
 *  - a monotonically increasing `generation` identifies the active connection;
 *  - the stream-token request runs under an `AbortController`;
 *  - Habitat change, reconnect replacement, or unmount aborts token work,
 *    cancels reconnect timers, closes the stream, and invalidates the old
 *    generation;
 *  - the generation is rechecked after every `await` and before installing the
 *    `EventSource`; an `EventSource` created by a stale generation is closed
 *    immediately and a stale generation performs no projection effect.
 *
 * Only fresh-generation events reach the ephemeral store update, the server
 * projector, and the recorded `recentSSEEvents` (which drives notifications), so
 * a stale subscription can never patch, invalidate, notify, or navigate.
 */
export function useSSE(boardId: string) {
  const queryClient = useQueryClient();
  const generationRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);
  const tokenAbortRef = useRef<AbortController | null>(null);
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;

  const connect = useCallback(async () => {
    const generation = ++generationRef.current;
    const subscriptionHabitatId = boardId;

    tokenAbortRef.current?.abort();
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    esRef.current?.close();
    esRef.current = null;

    const tokenAbort = new AbortController();
    tokenAbortRef.current = tokenAbort;

    let streamUrl = `/sse/habitats/${boardId}/stream`;
    const token = localStorage.getItem("orcy_token");
    if (token) {
      try {
        const res = await fetch("/api/auth/stream-token", {
          headers: { Authorization: `Bearer ${token}` },
          signal: tokenAbort.signal,
        });
        if (generation !== generationRef.current) return;
        if (res.ok) {
          const data = await res.json();
          if (generation !== generationRef.current) return;
          streamUrl = `/sse/habitats/${boardId}/stream?token=${encodeURIComponent(data.token)}`;
        }
      } catch {
        if (tokenAbort.signal.aborted || generation !== generationRef.current) return;
      }
    }

    if (generation !== generationRef.current) return;

    const es = new EventSource(streamUrl);
    if (generation !== generationRef.current) {
      es.close();
      return;
    }
    esRef.current = es;

    es.addEventListener("message", (e) => {
      if (generation !== generationRef.current) return;
      let event: SSEEvent;
      try {
        event = JSON.parse(e.data) as SSEEvent;
      } catch {
        return;
      }
      retryDelayRef.current = 1000;
      const isActive = () => generation === generationRef.current;
      const handleSSEEvent = useHabitatStore.getState().handleSSEEvent;
      handleSSEEvent(event);
      projectSSEServerEvent(event, {
        event,
        queryClient,
        subscriptionHabitatId,
        routeHabitatId: boardIdRef.current,
        isActive,
        navigateHome: () => {
          if (typeof window !== "undefined") window.location.hash = "#/";
        },
      });
    });

    es.addEventListener("error", () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
      if (generation !== generationRef.current) return;
      reconnectTimeoutRef.current = setTimeout(() => {
        if (generation !== generationRef.current) return;
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, 30000);
        void connect();
      }, retryDelayRef.current);
    });
  }, [boardId, queryClient]);

  useEffect(() => {
    void connect();
    return () => {
      generationRef.current++;
      tokenAbortRef.current?.abort();
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect]);
}
