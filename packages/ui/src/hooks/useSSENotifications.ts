import { useEffect, useRef } from "react";
import { useHabitatStore } from "../store/habitatStore.js";
import { notify } from "../lib/toast.js";
import { getSSEEventDedupeKey, getSSENotification } from "../sse/registry.js";

function getCurrentUserId(): string | null {
  const token = localStorage.getItem("orcy_token");
  if (!token) return null;

  try {
    const payload = JSON.parse(atob(token.split(".")[1])) as { sub?: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Subscribes to SSE events recorded in the store and emits toast notifications.
 * Uses a Set ref to deduplicate events within the session.
 * Replaces the previous monkey-patch pattern with a Zustand subscription.
 */
export function useSSENotifications() {
  const prevEventsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsub = useHabitatStore.subscribe((state, prevState) => {
      const newEvents = state.recentSSEEvents.filter(
        (e, i) => i >= prevState.recentSSEEvents.length,
      );

      if (newEvents.length === 0) return;

      for (const event of newEvents) {
        const eventKey = getSSEEventDedupeKey(event);

        if (prevEventsRef.current.has(eventKey)) continue;
        prevEventsRef.current.add(eventKey);

        const result = getSSENotification(event, state, getCurrentUserId());
        if (result?.app) {
          state.addNotification(result.app);
        }
        if (result?.toast) {
          notify[result.toast.level](result.toast.message);
        }
      }

      if (prevEventsRef.current.size > 500) {
        const arr = Array.from(prevEventsRef.current);
        prevEventsRef.current = new Set(arr.slice(-250));
      }
    });

    return unsub;
  }, []);
}
