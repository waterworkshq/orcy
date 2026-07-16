import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/index.js";
import {
  invalidateHabitatRepresentations,
  isVersionConflict,
  notifyVersionConflict,
  patchMissionInHabitatDetail,
  type HabitatDetailData,
} from "../lib/habitatMutations.js";
import { queryKeys } from "../lib/queryKeys.js";
import type { Mission } from "../types/index.js";

interface MoveEntry {
  habitatId: string;
  currentTarget: string;
  queuedTarget: string | null;
  controller: AbortController;
}

// Hung-request sweep bound. A never-resolving `api.missions.move` would keep
// the `finally` block suspended indefinitely — leaking `movesRef`, the preview,
// and `activeMoveCount` (perpetual spinner). On expiry we forcibly clean up
// the entry's UI state without aborting the controller (the server may have
// committed the move; a late resolve short-circuits via the controller-
// identity guard in runMove's completion path). Generous enough to tolerate
// a slow-but-successful response on adverse mobile networks; bounded so a
// true network hang self-corrects within UX tolerance.
export const HUNG_MOVE_TIMEOUT_MS = 30_000;

export interface DropArgs {
  missionId: string;
  canonicalColumnId: string;
  targetColumnId: string;
  expectedVersion: number;
}

export interface UseMissionDragMoveResult {
  previewByMission: Record<string, string>;
  isMoving: boolean;
  drop: (args: DropArgs) => void;
  setPreview: (missionId: string, targetColumnId: string) => void;
  clearPreview: (missionId: string) => void;
  restorePreview: (missionId: string) => void;
}

export function useMissionDragMove(habitatId: string | undefined): UseMissionDragMoveResult {
  const qc = useQueryClient();
  const [previewByMission, setPreviewByMission] = useState<Record<string, string>>({});
  const [activeMoveCount, setActiveMoveCount] = useState(0);
  const movesRef = useRef<Record<string, MoveEntry>>({});
  const generationRef = useRef(0);
  const committedHabitatRef = useRef(habitatId);

  const patchMissionInCache = useCallback(
    (mission: Mission) => {
      if (!habitatId) return;
      patchMissionInHabitatDetail(qc, habitatId, mission);
    },
    [qc, habitatId],
  );

  const invalidate = useCallback(() => {
    if (!habitatId) return;
    invalidateHabitatRepresentations(qc, habitatId);
  }, [qc, habitatId]);

  const clearPreview = useCallback((missionId: string) => {
    setPreviewByMission((prev) => {
      if (!prev[missionId]) return prev;
      const next = { ...prev };
      delete next[missionId];
      return next;
    });
  }, []);

  const clearOwnedPreview = useCallback((missionId: string, ownedTarget: string) => {
    setPreviewByMission((prev) => {
      if (prev[missionId] !== ownedTarget) return prev;
      const next = { ...prev };
      delete next[missionId];
      return next;
    });
  }, []);

  const runMove = useCallback(
    async (missionId: string, targetColumnId: string, expectedVersion: number) => {
      if (!habitatId) return;
      const generation = generationRef.current;
      const capturedHabitatId = habitatId;
      const isActive = () =>
        generation === generationRef.current && capturedHabitatId === committedHabitatRef.current;
      const controller = new AbortController();
      movesRef.current[missionId] = {
        habitatId: capturedHabitatId,
        currentTarget: targetColumnId,
        queuedTarget: null,
        controller,
      };
      setPreviewByMission((prev) => ({ ...prev, [missionId]: targetColumnId }));
      setActiveMoveCount((c) => c + 1);

      // Hung-request sweep: see HUNG_MOVE_TIMEOUT_MS rationale above.
      // cancelled by the natural-settle paths via clearTimeout so a normal
      // resolve doesn't trigger redundant cleanup. The sweep itself performs
      // its own controller-identity-guarded cleanup rather than relying on
      // the abort path (which intentionally early-returns on
      // `controller.signal.aborted` and would still leak the entry + preview).
      // We don't abort the controller here — preserving the documented
      // "a committed move is never silently aborted" semantics from the
      // habitat-switch cleanup at ~line 196. The server may have committed;
      // a late settlement lands via patchMissionInCache above and the
      // controller-identity guard in this block short-circuits the UI path.
      let sweepFired = false;
      const sweepTimer = setTimeout(() => {
        sweepFired = true;
        const entry = movesRef.current[missionId];
        if (entry && entry.controller === controller) {
          delete movesRef.current[missionId];
        }
        if (isActive()) {
          clearOwnedPreview(missionId, targetColumnId);
          setActiveMoveCount((c) => Math.max(0, c - 1));
        }
      }, HUNG_MOVE_TIMEOUT_MS);

      try {
        const { mission } = await api.missions.move(
          missionId,
          { columnId: targetColumnId, expectedVersion },
          controller.signal,
        );
        clearTimeout(sweepTimer);
        // Reconcile the CAPTURED habitat's cache regardless of a habitat switch:
        // the server may already have committed, so a committed move must never
        // be silently dropped. The closure wrappers target the captured habitat.
        patchMissionInCache(mission);
        invalidate();

        const entry = movesRef.current[missionId];
        if (!entry || entry.controller !== controller) return;
        if (
          isActive() &&
          entry.queuedTarget != null &&
          entry.queuedTarget !== entry.currentTarget
        ) {
          const nextTarget = entry.queuedTarget;
          delete movesRef.current[missionId];
          void runMove(missionId, nextTarget, mission.version);
          return;
        }
        delete movesRef.current[missionId];
        if (!isActive()) return;
        clearOwnedPreview(missionId, targetColumnId);
      } catch (err) {
        clearTimeout(sweepTimer);
        if (controller.signal.aborted) return;
        invalidate();
        const entry = movesRef.current[missionId];
        if (entry && entry.controller === controller) delete movesRef.current[missionId];
        if (!isActive()) return;
        clearOwnedPreview(missionId, targetColumnId);
        if (isVersionConflict(err)) {
          notifyVersionConflict("This mission", invalidate);
        }
      } finally {
        // Skip the decrement if the sweep already cleaned up — otherwise a
        // late settle (rare but possible) would double-decrement and strand
        // `isMoving=false` going negative, masking a fresh in-flight drop.
        if (isActive() && !sweepFired) {
          setActiveMoveCount((c) => c - 1);
        }
      }
    },
    [habitatId, patchMissionInCache, invalidate, clearOwnedPreview],
  );

  const resolveCanonicalVersion = useCallback(
    (missionId: string, fallback: number) => {
      if (!habitatId) return fallback;
      const detail = qc.getQueryData<HabitatDetailData>(queryKeys.habitats.detail(habitatId));
      const cached = detail?.missions.find((m) => m.id === missionId);
      return cached ? cached.version : fallback;
    },
    [qc, habitatId],
  );

  const drop = useCallback(
    (args: DropArgs) => {
      const { missionId, canonicalColumnId, targetColumnId, expectedVersion } = args;
      const existing = movesRef.current[missionId];
      // Coalesce only onto an entry belonging to the CURRENT habitat; a stale
      // entry from a pre-switch habitat is overwritten by the fresh move below.
      if (existing && existing.habitatId === habitatId) {
        existing.queuedTarget = targetColumnId;
        setPreviewByMission((prev) => ({ ...prev, [missionId]: targetColumnId }));
        return;
      }
      if (targetColumnId === canonicalColumnId) {
        clearPreview(missionId);
        return;
      }
      const canonicalVersion = resolveCanonicalVersion(missionId, expectedVersion);
      void runMove(missionId, targetColumnId, canonicalVersion);
    },
    [runMove, clearPreview, habitatId, resolveCanonicalVersion],
  );

  const setPreview = useCallback((missionId: string, targetColumnId: string) => {
    setPreviewByMission((prev) => ({ ...prev, [missionId]: targetColumnId }));
  }, []);

  const restorePreview = useCallback(
    (missionId: string) => {
      const entry = movesRef.current[missionId];
      if (entry) {
        const resting = entry.queuedTarget ?? entry.currentTarget;
        setPreviewByMission((prev) => ({ ...prev, [missionId]: resting }));
      } else {
        clearPreview(missionId);
      }
    },
    [clearPreview],
  );

  // The committed Habitat is recorded before paint (layout phase) so a stale
  // move completion landing in the commit-to-cleanup window — after a habitat
  // switch has rendered but before the passive cleanup bumps the generation —
  // is rejected by the dual isActive predicate (generation AND committed
  // habitat), mirroring the SSE lifecycle guard.
  useLayoutEffect(() => {
    committedHabitatRef.current = habitatId;
  }, [habitatId]);

  useEffect(() => {
    setActiveMoveCount(0);
    setPreviewByMission({});
    return () => {
      // Bump the generation so stale completions skip UI continuations for the
      // new habitat. A committed move is NEVER aborted: the server may already
      // have applied it, so the in-flight entry is left to complete and patch
      // its captured habitat's cache (reconciling on revisit). Entries self-
      // clean via the controller-identity guard in the completion path.
      generationRef.current++;
      setActiveMoveCount(0);
      setPreviewByMission({});
    };
  }, [habitatId]);

  return {
    previewByMission,
    isMoving: activeMoveCount > 0,
    drop,
    setPreview,
    clearPreview,
    restorePreview,
  };
}
