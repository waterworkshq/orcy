import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/transport.js";
import { notify } from "./toast.js";
import { queryKeys } from "./queryKeys.js";
import type { Column, Mission, MissionWithProgress, PublicHabitat } from "../types/index.js";

/**
 * Canonical Habitat-detail Query shape. The main board, sprint, and dependency
 * consumers all read the complete active-Mission collection from this key.
 */
export type HabitatDetailData = {
  habitat: PublicHabitat;
  columns: Column[];
  missions: MissionWithProgress[];
};

/**
 * Guarded merge of a canonical Mission into the Habitat-detail active collection.
 *
 * Applies only when the returned version is NOT older than the cached
 * representation, and only for a Mission that is already cached. A create or
 * unarchive response lacks derived `progress`, so it cannot be inserted safely;
 * callers invalidate to reconcile those membership changes. The cached derived
 * `progress` is always preserved when the response omits it.
 *
 * This never restores a stale snapshot over a potentially newer cache.
 */
export function patchMissionInHabitatDetail(
  qc: QueryClient,
  habitatId: string,
  mission: Mission,
): void {
  const detailKey = queryKeys.habitats.detail(habitatId);
  qc.setQueryData<HabitatDetailData>(detailKey, (old) => {
    if (!old) return old;
    const existing = old.missions.find((m) => m.id === mission.id);
    if (!existing) return old;
    if (existing.version > mission.version) return old;
    return {
      ...old,
      missions: old.missions.map((m) =>
        m.id === mission.id ? { ...m, ...mission, progress: m.progress } : m,
      ),
    };
  });
}

/**
 * Hard-delete a Mission from the Habitat-detail active collection. Unconditional
 * removal by id — used for a confirmed delete where the canonical event
 * authoritatively removes the entry regardless of cached version. Background
 * invalidation remains the reconciliation authority.
 */
export function removeMissionFromHabitatDetail(
  qc: QueryClient,
  habitatId: string,
  missionId: string,
): void {
  const detailKey = queryKeys.habitats.detail(habitatId);
  qc.setQueryData<HabitatDetailData>(detailKey, (old) => {
    if (!old) return old;
    if (!old.missions.some((m) => m.id === missionId)) return old;
    return {
      ...old,
      missions: old.missions.filter((m) => m.id !== missionId),
    };
  });
}

/**
 * Archive-remove a canonical Mission from the Habitat-detail active collection.
 * Version-guarded: removes only when `cached.version <= archived.version`, so a
 * delayed archive event (older version) cannot evict a newer active entry — e.g.
 * one reinstalled by an unarchive refetch after this archive was generated.
 * Distinct from hard-delete, which is unconditional.
 */
export function archiveMissionFromHabitatDetail(
  qc: QueryClient,
  habitatId: string,
  mission: Mission,
): void {
  const detailKey = queryKeys.habitats.detail(habitatId);
  qc.setQueryData<HabitatDetailData>(detailKey, (old) => {
    if (!old) return old;
    const cached = old.missions.find((m) => m.id === mission.id);
    if (!cached) return old;
    if (cached.version > mission.version) return old;
    return {
      ...old,
      missions: old.missions.filter((m) => m.id !== mission.id),
    };
  });
}

/**
 * Install the canonical Column order returned by the atomic reorder endpoint.
 * Applied only when the response covers the same column membership as the cache;
 * otherwise left for background invalidation to reconcile.
 */
export function patchColumnsInHabitatDetail(
  qc: QueryClient,
  habitatId: string,
  columns: Column[],
): void {
  const detailKey = queryKeys.habitats.detail(habitatId);
  qc.setQueryData<HabitatDetailData>(detailKey, (old) => {
    if (!old) return old;
    if (old.columns.length !== columns.length) return old;
    const responseIds = new Set(columns.map((c) => c.id));
    for (const c of old.columns) {
      if (!responseIds.has(c.id)) return old;
    }
    return { ...old, columns };
  });
}

/**
 * Invalidate every Habitat-scoped representation a mutation can affect:
 * Habitat detail, stats, the finite events key, the mission-list filters, and
 * the offset-based events-infinite family (reset, not invalidated, so the
 * accumulated offset pages are discarded rather than left stale).
 */
export function invalidateHabitatRepresentations(qc: QueryClient, habitatId: string): void {
  qc.invalidateQueries({ queryKey: queryKeys.habitats.detail(habitatId) });
  qc.invalidateQueries({ queryKey: queryKeys.habitats.stats(habitatId) });
  qc.invalidateQueries({ queryKey: queryKeys.habitats.events(habitatId) });
  qc.invalidateQueries({ queryKey: queryKeys.missions.list(habitatId) });
  resetEventsInfiniteForHabitat(qc, habitatId);
}

/**
 * Reset the events-infinite offset family from offset zero. Used on membership
 * or lifecycle changes that can shift the activity feed (task events, mission
 * mutations). Reset (not invalidate) because offset-based accumulated pages
 * cannot be reconciled by a background refetch — they must be discarded.
 */
export function resetEventsInfiniteForHabitat(qc: QueryClient, habitatId: string): void {
  qc.resetQueries({
    queryKey: [...queryKeys.habitats.all, "eventsInfinite", habitatId],
  });
}

/**
 * Reset the archived-Mission infinite query from offset zero. Used on
 * membership/order changes (archive/unarchive/delete/reorder) per the mutable
 * offset-reset contract.
 */
export function resetArchivedForHabitat(qc: QueryClient, habitatId: string): void {
  qc.resetQueries({
    queryKey: [...queryKeys.missions.all, "archived", habitatId],
  });
}

/**
 * Invalidate Mission-detail representations: detail, details composite, tasks,
 * and progress.
 */
export function invalidateMissionRepresentations(qc: QueryClient, missionId: string): void {
  qc.invalidateQueries({ queryKey: queryKeys.missions.detail(missionId) });
  qc.invalidateQueries({ queryKey: queryKeys.missions.details(missionId) });
  qc.invalidateQueries({ queryKey: queryKeys.missions.tasks(missionId) });
  qc.invalidateQueries({ queryKey: queryKeys.missions.progress(missionId) });
}

/** True when an error is an HTTP 409 version conflict. */
export function isVersionConflict(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409;
}

/**
 * Surface a version conflict distinctly (never as a generic network failure)
 * and force reconciliation through the supplied invalidate callback.
 */
export function notifyVersionConflict(subject: string, reconcile: () => void): void {
  notify.error(`${subject} was modified by someone else. Refreshing to the latest.`, {
    action: { label: "Retry", onClick: reconcile },
  });
}
