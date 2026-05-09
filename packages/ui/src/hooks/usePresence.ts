import { useEffect, useRef } from 'react';
import { api } from '../api/index.js';

function generateSessionId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getStoredUser(): { id: string; username: string } | null {
  try {
    const raw = localStorage.getItem('orcy_user');
    if (!raw) return null;
    return JSON.parse(raw) as { id: string; username: string };
  } catch {
    return null;
  }
}

/**
 * Tracks the current user's presence on a board: joins on mount, sends heartbeats
 * every 30 s, and sends a sendBeacon on unload to mark the session as gone.
 */
export function usePresence(boardId: string | null | undefined) {
  const sessionIdRef = useRef<string>(generateSessionId());
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!boardId) return;

    const user = getStoredUser();
    const sessionId = sessionIdRef.current;

    api.presence.join({
      sessionId,
      type: 'human',
      boardId,
      userId: user?.id,
      userName: user?.username,
    }).catch(() => {});

    heartbeatRef.current = setInterval(() => {
      api.presence.heartbeat({
        sessionId,
        boardId,
      }).catch(() => {});
    }, 30_000);

    const handleUnload = () => {
      navigator.sendBeacon?.(
        '/sse/presence/leave',
        new Blob([JSON.stringify({ sessionId, boardId })], { type: 'application/json' })
      );
    };
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      window.removeEventListener('beforeunload', handleUnload);
      api.presence.leave({ sessionId, boardId }).catch(() => {});
    };
  }, [boardId]);
}
