import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/index.js";
import {
  invalidateHabitatRepresentations,
  isVersionConflict,
  notifyVersionConflict,
  patchMissionInHabitatDetail,
} from "../lib/habitatMutations.js";
import type { Mission } from "../types/index.js";

interface MoveEntry {
  currentTarget: string;
  queuedTarget: string | null;
  controller: AbortController;
}

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

  const runMove = useCallback(
    async (missionId: string, targetColumnId: string, expectedVersion: number) => {
      const generation = generationRef.current;
      const capturedHabitatId = habitatId;
      const isActive = () =>
        generation === generationRef.current && capturedHabitatId === committedHabitatRef.current;
      const controller = new AbortController();
      movesRef.current[missionId] = {
        currentTarget: targetColumnId,
        queuedTarget: null,
        controller,
      };
      setPreviewByMission((prev) => ({ ...prev, [missionId]: targetColumnId }));
      setActiveMoveCount((c) => c + 1);

      try {
        const { mission } = await api.missions.move(
          missionId,
          { columnId: targetColumnId, expectedVersion },
          controller.signal,
        );
        if (!isActive()) return;
        patchMissionInCache(mission);
        invalidate();

        const entry = movesRef.current[missionId];
        if (!entry || entry.controller !== controller) return;
        if (entry.queuedTarget && entry.queuedTarget !== entry.currentTarget) {
          const nextTarget = entry.queuedTarget;
          delete movesRef.current[missionId];
          void runMove(missionId, nextTarget, mission.version);
          return;
        }
        delete movesRef.current[missionId];
        clearPreview(missionId);
      } catch (err) {
        if (controller.signal.aborted || !isActive()) return;
        delete movesRef.current[missionId];
        clearPreview(missionId);
        if (isVersionConflict(err)) {
          notifyVersionConflict("This mission", invalidate);
        }
        invalidate();
      } finally {
        if (isActive()) {
          setActiveMoveCount((c) => c - 1);
        }
      }
    },
    [habitatId, patchMissionInCache, invalidate, clearPreview],
  );

  const drop = useCallback(
    (args: DropArgs) => {
      const { missionId, canonicalColumnId, targetColumnId, expectedVersion } = args;
      const existing = movesRef.current[missionId];
      if (existing) {
        existing.queuedTarget = targetColumnId;
        setPreviewByMission((prev) => ({ ...prev, [missionId]: targetColumnId }));
        return;
      }
      if (targetColumnId === canonicalColumnId) {
        clearPreview(missionId);
        return;
      }
      void runMove(missionId, targetColumnId, expectedVersion);
    },
    [runMove, clearPreview],
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
      generationRef.current++;
      for (const id of Object.keys(movesRef.current)) {
        movesRef.current[id]?.controller.abort();
      }
      movesRef.current = {};
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
