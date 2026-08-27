import { useEffect, useRef } from 'react';
import { api } from '../api/index.js';

function generateSessionId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Tracks the current user's presence on a board: joins on mount, sends heartbeats
 * every 30 s, and sends an authenticated leave on React cleanup. Abrupt closes
 * (crash, kill) have no unload beacon — the server expires the session through
 * its 120-second stale-entry cleanup.
 */
export function usePresence(habitatId: string | null | undefined) {
  const sessionIdRef = useRef<string>(generateSessionId());
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!habitatId) return;

    const sessionId = sessionIdRef.current;

    api.presence.join({
      sessionId,
      habitatId,
    }).catch(() => {});

    heartbeatRef.current = setInterval(() => {
      api.presence.heartbeat({
        sessionId,
        habitatId,
      }).catch(() => {});
    }, 30_000);

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      api.presence.leave({ sessionId, habitatId }).catch(() => {});
    };
  }, [habitatId]);
}
