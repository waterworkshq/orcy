import { useCallback, useEffect, useRef, useState } from "react";
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
}

export function useMissionDragMove(habitatId: string | undefined): UseMissionDragMoveResult {
  const qc = useQueryClient();
  const [previewByMission, setPreviewByMission] = useState<Record<string, string>>({});
  const [activeMoveCount, setActiveMoveCount] = useState(0);
  const movesRef = useRef<Record<string, MoveEntry>>({});

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
      setPreviewByMission((prev) => ({ ...prev, [missionId]: targetColumnId }));
      movesRef.current[missionId] = { currentTarget: targetColumnId, queuedTarget: null };
      setActiveMoveCount((c) => c + 1);

      try {
        const { mission } = await api.missions.move(missionId, {
          columnId: targetColumnId,
          expectedVersion,
        });
        patchMissionInCache(mission);
        invalidate();

        const entry = movesRef.current[missionId];
        if (entry && entry.queuedTarget && entry.queuedTarget !== entry.currentTarget) {
          const nextTarget = entry.queuedTarget;
          movesRef.current[missionId] = { currentTarget: nextTarget, queuedTarget: null };
          void runMove(missionId, nextTarget, mission.version);
          return;
        }
        delete movesRef.current[missionId];
        clearPreview(missionId);
      } catch (err) {
        delete movesRef.current[missionId];
        clearPreview(missionId);
        if (isVersionConflict(err)) {
          notifyVersionConflict("This mission", invalidate);
        }
        invalidate();
      } finally {
        setActiveMoveCount((c) => c - 1);
      }
    },
    [patchMissionInCache, invalidate, clearPreview],
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

  useEffect(() => {
    movesRef.current = {};
    setPreviewByMission({});
  }, [habitatId]);

  return {
    previewByMission,
    isMoving: activeMoveCount > 0,
    drop,
    setPreview,
    clearPreview,
  };
}
