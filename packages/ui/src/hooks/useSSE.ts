import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
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
 * Commit/cleanup window hardening: the committed Habitat is recorded in a
 * ref updated by a *layout* effect (before paint), never during render, and the
 * shared `isActive()` predicate requires BOTH generation equality AND that the
 * subscription's Habitat still matches the committed Habitat. Passive-effect
 * cleanup (which bumps the generation) runs after paint, so without the
 * committed-Habitat leg a stale subscription A could still read as "active"
 * in the window between B committing and A's cleanup running. `isActive()` is
 * rechecked after every await, before `EventSource` construction, and in every
 * callback, so a stale generation can never patch, invalidate, notify, or
 * navigate.
 */
export function useSSE(boardId: string) {
  const queryClient = useQueryClient();
  const generationRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);
  const tokenAbortRef = useRef<AbortController | null>(null);
  const committedHabitatRef = useRef(boardId);

  const abortGeneration = useCallback(() => {
    generationRef.current++;
    tokenAbortRef.current?.abort();
    tokenAbortRef.current = null;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    const generation = ++generationRef.current;
    const subscriptionHabitatId = boardId;
    const isActive = () =>
      generation === generationRef.current && subscriptionHabitatId === committedHabitatRef.current;

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
        if (!isActive()) return;
        if (res.ok) {
          const data = await res.json();
          if (!isActive()) return;
          streamUrl = `/sse/habitats/${boardId}/stream?token=${encodeURIComponent(data.token)}`;
        }
      } catch {
        if (tokenAbort.signal.aborted || !isActive()) return;
      }
    }

    if (!isActive()) return;

    const es = new EventSource(streamUrl);
    if (!isActive()) {
      es.close();
      return;
    }
    esRef.current = es;

    es.addEventListener("message", (e) => {
      if (!isActive()) return;
      let event: SSEEvent;
      try {
        event = JSON.parse(e.data) as SSEEvent;
      } catch {
        return;
      }
      retryDelayRef.current = 1000;
      const handleSSEEvent = useHabitatStore.getState().handleSSEEvent;
      handleSSEEvent(event);
      projectSSEServerEvent(event, {
        event,
        queryClient,
        subscriptionHabitatId,
        routeHabitatId: committedHabitatRef.current,
        isActive,
        navigateHome: () => {
          if (!isActive()) return;
          if (typeof window !== "undefined") window.location.hash = "#/";
        },
      });
    });

    es.addEventListener("error", () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
      if (!isActive()) return;
      reconnectTimeoutRef.current = setTimeout(() => {
        if (!isActive()) return;
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, 30000);
        void connect();
      }, retryDelayRef.current);
    });
  }, [boardId, queryClient]);

  useLayoutEffect(() => {
    committedHabitatRef.current = boardId;
  }, [boardId]);

  useEffect(() => {
    void connect();
    return () => {
      abortGeneration();
    };
  }, [connect, abortGeneration]);
}
