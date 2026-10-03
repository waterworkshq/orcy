import { eq } from "drizzle-orm";

import { getDb } from "../../db/index.js";
import { habitats, missions, tasks } from "../../db/schema/index.js";
import type { CodeEvidenceTargetType } from "@orcy/shared";

/** Client accepted by the exact-row seam (top-level db or a transaction). */
export type CompatibilityDbClient = ReturnType<typeof getDb>;

/** A fetched Task row plus the raw spelling that selected it. */
export type ResolvedTask = {
  kind: "task";
  rawId: string;
  row: typeof tasks.$inferSelect;
};

/** A fetched Mission row plus the raw spelling that selected it. */
export type ResolvedMission = {
  kind: "mission";
  rawId: string;
  row: typeof missions.$inferSelect;
};

export type ResolvedEvidenceTarget = ResolvedTask | ResolvedMission;

/** A stored target pair (polymorphic, no FK) as persisted on evidence rows. */
export type StoredTargetPair = { type: CodeEvidenceTargetType; id: string };

export type CompatibilityPairs = {
  canonical: StoredTargetPair;
  legacy: StoredTargetPair | null;
};

/**
 * Exact stored-id Task lookup. Unlike the public `getTaskById`, this never
 * strips the `feat-` prefix: it is the collision probe for canonical exact
 * ownership (a literal Task named `feat-X` shadows the alias adoption for
 * canonical Task `X`) and the identity read for already-canonical ids.
 */
export function getTaskRowExact(
  id: string,
  client?: CompatibilityDbClient,
): typeof tasks.$inferSelect | null {
  const db = client ?? getDb();
  return db.select().from(tasks).where(eq(tasks.id, id)).get() ?? null;
}

/** Exact stored-id Mission lookup — no `mission-` fallback, no prefix handling. */
export function getMissionRowExact(
  id: string,
  client?: CompatibilityDbClient,
): typeof missions.$inferSelect | null {
  const db = client ?? getDb();
  return db.select().from(missions).where(eq(missions.id, id)).get() ?? null;
}

/** Exact stored-id Habitat lookup — existence only, no membership semantics. */
export function getHabitatRowExact(
  id: string,
  client?: CompatibilityDbClient,
): typeof habitats.$inferSelect | null {
  const db = client ?? getDb();
  return db.select().from(habitats).where(eq(habitats.id, id)).get() ?? null;
}

/** Resolves a Task URL/trailer spelling through the current one-strip grammar and returns the fetched row. */
export function resolveTaskRow(
  rawId: string,
  client?: CompatibilityDbClient,
): ResolvedTask | null {
  const normalized = rawId.startsWith("feat-") ? rawId.slice(5) : rawId;
  const row = getTaskRowExact(normalized, client);
  return row ? { kind: "task", rawId, row } : null;
}

/**
 * Resolves a Mission URL/trailer spelling through the repository's current
 * exact-before-`mission-`-fallback grammar and returns the fetched row. This
 * mirrors `getMissionById` without importing its high-fanout surface.
 */
export function resolveMissionRow(
  rawId: string,
  client?: CompatibilityDbClient,
): ResolvedMission | null {
  const exact = getMissionRowExact(rawId, client);
  if (exact) return { kind: "mission", rawId, row: exact };
  if (rawId.startsWith("mission-")) return null;
  const fallback = getMissionRowExact(`mission-${rawId}`, client);
  return fallback ? { kind: "mission", rawId, row: fallback } : null;
}

/** Resolves either target kind by raw spelling under its current transport grammar. */
export function resolveEvidenceTarget(
  kind: CodeEvidenceTargetType,
  rawId: string,
  client?: CompatibilityDbClient,
): ResolvedEvidenceTarget | null {
  return kind === "task" ? resolveTaskRow(rawId, client) : resolveMissionRow(rawId, client);
}

/**
 * The finite inverse candidate for a canonical Task id `C`: the stored text
 * `feat-${C}`. It is a VERIFIED legacy pair only when (a) resolving that
 * text through the current Task grammar selects Task `C` (true whenever `C`
 * exists, since one strip maps `feat-C` to `C`), and (b) no other actual Task
 * is literally stored with id `feat-${C}` — canonical exact ownership wins
 * the collision, and the pair stays with that literal Task instead.
 */
function taskLegacyPairFor(
  canonicalTaskId: string,
  client?: CompatibilityDbClient,
): StoredTargetPair | null {
  const candidate = `feat-${canonicalTaskId}`;
  const resolved = resolveTaskRow(candidate, client);
  if (!resolved || resolved.row.id !== canonicalTaskId) return null;
  // Collision fence: an exact stored Task with the candidate id owns the pair.
  if (getTaskRowExact(candidate, client)) return null;
  return { type: "task", id: candidate };
}

/**
 * The finite inverse candidate for a canonical Mission id `C` starting with
 * `mission-`: the stored text with that one prefix removed. Verified only
 * when the candidate does not itself start with `mission-` (nested
 * `mission-mission-X` has no fallback inverse), no literal Mission shadows
 * the exact candidate lookup, and the repository fallback
 * `mission-${candidate}` actually selects `C`. The empty candidate for
 * `C = "mission-"` is included under the same verification.
 */
function missionLegacyPairFor(
  canonicalMissionId: string,
  client?: CompatibilityDbClient,
): StoredTargetPair | null {
  if (!canonicalMissionId.startsWith("mission-")) return null;
  const candidate = canonicalMissionId.slice("mission-".length);
  if (candidate.startsWith("mission-")) return null;
  // Exact-row shadowing: a literal Mission with the candidate id owns that pair.
  if (getMissionRowExact(candidate, client)) return null;
  const resolved = resolveMissionRow(candidate, client);
  if (!resolved || resolved.row.id !== canonicalMissionId) return null;
  return { type: "mission", id: candidate };
}

/**
 * Computes the canonical exact pair and its at-most-one verified legacy pair
 * for a fetched target row. This is the complete finite adoption universe
 * under the current resolver grammars — there is deliberately no table-wide
 * alias scan, no arbitrary historical-pair union, and no migration.
 */
export function computeCompatibilityPairs(
  kind: CodeEvidenceTargetType,
  canonicalRowId: string,
  client?: CompatibilityDbClient,
): CompatibilityPairs {
  const canonical: StoredTargetPair = { type: kind, id: canonicalRowId };
  if (kind === "task") {
    return { canonical, legacy: taskLegacyPairFor(canonicalRowId, client) };
  }
  return { canonical, legacy: missionLegacyPairFor(canonicalRowId, client) };
}

/**
 * Re-derives compatibility pairs from the live rows, re-verifying every
 * adoption precondition. Called inside the mark/clear transactions so a
 * newly created literal Task/Mission between requests changes the adoption
 * verdict rather than being adopted or cleared through stale state.
 */
export function recomputeCompatibilityPairs(
  kind: CodeEvidenceTargetType,
  canonicalRowId: string,
  client?: CompatibilityDbClient,
): CompatibilityPairs {
  return computeCompatibilityPairs(kind, canonicalRowId, client);
}

/**
 * The stored pairs a selected evidence resource (link/gap addressed by
 * resource id) may belong to while still being operated through this URL
 * target: the canonical exact pair, plus the verified legacy pair when one
 * exists. The final UPDATE still fences the row's OWN stored exact pair.
 */
export function acceptableSourcePairs(pairs: CompatibilityPairs): StoredTargetPair[] {
  return pairs.legacy ? [pairs.canonical, pairs.legacy] : [pairs.canonical];
}

/** True when a stored row's pair is one of the acceptable source pairs. */
export function rowMatchesAcceptablePair(
  row: { targetType: string; targetId: string },
  acceptable: StoredTargetPair[],
): boolean {
  return acceptable.some((p) => p.type === row.targetType && p.id === row.targetId);
}

/**
 * Resolves the exact Task row for event emission: the canonical id of a
 * literal `feat-X` Task must NOT be pushed through the one-strip resolver a
 * second time (that would select Task `X`). Returns the row read by exact id.
 */
export function taskRowForEvent(canonicalTaskId: string): typeof tasks.$inferSelect | null {
  return getTaskRowExact(canonicalTaskId);
}

/** Resolves the exact Mission row for event emission (canonical Mission ids are exact-safe). */
export function missionRowForEvent(
  canonicalMissionId: string,
): typeof missions.$inferSelect | null {
  return getMissionRowExact(canonicalMissionId);
}
