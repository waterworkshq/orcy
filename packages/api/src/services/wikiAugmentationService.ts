import * as wikiPageRepo from "../repositories/wikiPage.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as habitatSkillRepo from "../repositories/habitatSkill.js";
import * as insightRepo from "../repositories/insight.js";
import * as effortEntryRepo from "../repositories/effortEntry.js";
import * as commentRepo from "../repositories/comment.js";
import * as codeEvidenceRepository from "../repositories/codeEvidenceRepository.js";
import { notFound } from "../errors.js";
import type { EffortEntry } from "@orcy/shared";

/** Soft cap on rows returned per primitive type from the augmentation context. Configurable per-call. */
const DEFAULT_PRIMITIVE_LIMIT = 100;

/** Soft cap on rows returned by {@link getRelevantPrimitives} (reactive-suggest). Capped low per the locked v0.21 decision — no relevance ranking in this release. */
const RELEVANT_PRIMITIVES_LIMIT = 20;

/**
 * Grouped authoring context returned by {@link wikiAugmentationService.getAuthoringContextForEdit}
 * and {@link wikiAugmentationService.getAuthoringContextForChunk}. The shape is identical between
 * the two modes so consumers (the authoring editor panel, the `get_authoring_context` MCP action)
 * can render one view over both.
 */
export interface AuthoringContext {
  /** Habitat id the context belongs to. Echoed back for convenience. */
  habitatId: string;
  /** Lower bound (`>=`) used for the primitive query — either the page's `lastUpdatedAt` (delta) or the chunk `from` (chunk). */
  from: string;
  /** Upper bound (`<=`) used for the primitive query — only set in chunk mode. */
  to: string | null;
  /** Optional keyword filter echoed back when the caller passed a `query` (chunk mode). */
  query: string | null;
  /** Pulses (`pulses` table) updated in the window, scoped to the habitat. */
  pulses: pulseRepo.Pulse[];
  /** Habitat skill signals updated in the window. */
  skillSignals: habitatSkillRepo.HabitatSkillSignal[];
  /** Active project insights (`project_insights`) created in the window. */
  insights: insightRepo.ProjectInsight[];
  /** Code-evidence links (`code_evidence_links`) linked in the window. */
  evidence: Array<Record<string, unknown>>;
  /** Effort entries (`effort_entries`) recorded in the window. */
  effort: EffortEntry[];
  /** Comments (`task_comments` + `mission_comments`) created in the window. */
  comments: commentRepo.ScopedComment[];
}

/**
 * Returns the primitives the author of an existing page would care about: rows updated strictly
 * after the page's `lastUpdatedAt`, scoped to the page's habitat. Deterministic timestamp filter
 * — no relevance ranking (locked v0.21 decision; ARCHITECTURE.md §3.2).
 *
 * Throws 404 when the page is missing.
 */
export function getAuthoringContextForEdit(
  pageId: string,
  options: { primitiveLimit?: number } = {},
): AuthoringContext {
  const page = wikiPageRepo.getById(pageId);
  if (!page) throw notFound(`Wiki page not found: ${pageId}`);

  const limit = options.primitiveLimit ?? DEFAULT_PRIMITIVE_LIMIT;
  return {
    habitatId: page.habitatId,
    from: page.lastUpdatedAt,
    to: null,
    query: null,
    pulses: pulseRepo
      .listByHabitatSince(page.habitatId, page.lastUpdatedAt, limit)
      .filter((p) => p.signalType !== "experience"),
    skillSignals: habitatSkillRepo.listByHabitatSince(page.habitatId, page.lastUpdatedAt, limit),
    insights: insightRepo.listActiveByHabitatSince(page.habitatId, page.lastUpdatedAt, limit),
    evidence: codeEvidenceRepository.listByHabitatSince(page.habitatId, page.lastUpdatedAt, limit),
    effort: effortEntryRepo.listByHabitatSince(page.habitatId, page.lastUpdatedAt, limit),
    comments: commentRepo.listByHabitatSince(page.habitatId, page.lastUpdatedAt, limit),
  };
}

/** Input for {@link getAuthoringContextForChunk} — bounded window + optional keyword filter. */
export interface ChunkContextInput {
  from: string;
  to: string;
  query?: string;
}

/**
 * Returns the primitives that fall inside an explicit `[from, to]` window for a habitat, with an
 * optional dumb `LIKE` keyword filter applied to subject / body / summary text. Used by
 * scheduler-spawned authoring tasks (Phase 6) and the new-page authoring flow
 * (`POST /wiki/authoring-context`).
 *
 * Keyword matching is intentionally dumb (no FTS, no relevance ranking, no stemming). v0.21's
 * locked decision: deterministic only. Any ranking leads to RAG-system territory and is
 * explicitly out of scope.
 */
export function getAuthoringContextForChunk(
  habitatId: string,
  input: ChunkContextInput,
  options: { primitiveLimit?: number } = {},
): AuthoringContext {
  const limit = options.primitiveLimit ?? DEFAULT_PRIMITIVE_LIMIT;
  const query = input.query ?? null;
  const queryFilter = query ? query.toLowerCase() : null;

  const matches = (
    subject: string | null | undefined,
    body: string | null | undefined,
  ): boolean => {
    if (!queryFilter) return true;
    const s = (subject ?? "").toLowerCase();
    const b = (body ?? "").toLowerCase();
    return s.includes(queryFilter) || b.includes(queryFilter);
  };

  return {
    habitatId,
    from: input.from,
    to: input.to,
    query,
    pulses: filter(
      pulseRepo
        .listByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z", limit * 4)
        .filter((p) => p.signalType !== "experience"),
      (p) => p.createdAt >= input.from && p.createdAt <= input.to && matches(p.subject, p.body),
      limit,
    ),
    skillSignals: filter(
      habitatSkillRepo.listByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z", limit * 4),
      (s) => s.updatedAt >= input.from && s.updatedAt <= input.to && matches(s.subject, s.summary),
      limit,
    ),
    insights: filter(
      insightRepo.listActiveByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z", limit * 4),
      (i) => i.createdAt >= input.from && i.createdAt <= input.to && matches(i.subject, i.body),
      limit,
    ),
    evidence: filter(
      codeEvidenceRepository.listByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z", limit * 4),
      (e) => {
        const ts = String(e.linkedAt ?? "");
        return (
          ts >= input.from &&
          ts <= input.to &&
          matches(stringOrNull(e.title), stringOrNull(e.description))
        );
      },
      limit,
    ),
    effort: filter(
      effortEntryRepo.listByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z", limit * 4),
      (e) =>
        e.recordedAt >= input.from && e.recordedAt <= input.to && matches(null, e.note ?? null),
      limit,
    ),
    comments: filter(
      commentRepo.listByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z", limit * 4),
      (c) => c.createdAt >= input.from && c.createdAt <= input.to && matches(null, c.content),
      limit,
    ),
  };
}

/** Input for {@link getRelevantPrimitives} — keyword-driven reactive suggest. */
export interface RelevantPrimitivesInput {
  query?: string;
  limit?: number;
}

/**
 * Reactive-suggest power feature (hybrid Q7a). Keyword `LIKE`-matches across primitive
 * subject/body/summary text for the habitat and returns a single ranked-by-recency flat list.
 * Capped at {@link RELEVANT_PRIMITIVES_LIMIT}. Intentionally dumb — no embeddings, no relevance
 * ranking beyond recency. This is the ceiling of capability in v0.21.
 */
export interface RelevantPrimitive {
  id: string;
  type: "pulse" | "skill_signal" | "insight" | "evidence" | "effort" | "comment";
  subject: string;
  body: string;
  habitatId: string;
  createdAt: string;
}

export function getRelevantPrimitives(
  habitatId: string,
  input: RelevantPrimitivesInput = {},
): RelevantPrimitive[] {
  const limit = Math.min(input.limit ?? RELEVANT_PRIMITIVES_LIMIT, RELEVANT_PRIMITIVES_LIMIT);
  const query = (input.query ?? "").toLowerCase();
  if (!query) return [];

  const matches = (
    subject: string | null | undefined,
    body: string | null | undefined,
  ): boolean => {
    return (
      (subject ?? "").toLowerCase().includes(query) || (body ?? "").toLowerCase().includes(query)
    );
  };

  const results: RelevantPrimitive[] = [];

  for (const p of pulseRepo.listByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z", limit * 4)) {
    if (matches(p.subject, p.body)) {
      results.push({
        id: p.id,
        type: "pulse",
        subject: p.subject,
        body: p.body,
        habitatId: p.habitatId,
        createdAt: p.createdAt,
      });
    }
  }
  for (const s of habitatSkillRepo.listByHabitatSince(
    habitatId,
    "1970-01-01T00:00:00.000Z",
    limit * 4,
  )) {
    if (matches(s.subject, s.summary)) {
      results.push({
        id: s.id,
        type: "skill_signal",
        subject: s.subject,
        body: s.summary ?? "",
        habitatId: s.habitatId,
        createdAt: s.lastSeenAt,
      });
    }
  }
  for (const i of insightRepo.listActiveByHabitatSince(
    habitatId,
    "1970-01-01T00:00:00.000Z",
    limit * 4,
  )) {
    if (matches(i.subject, i.body)) {
      results.push({
        id: i.id,
        type: "insight",
        subject: i.subject,
        body: i.body,
        habitatId: i.habitatId,
        createdAt: i.createdAt,
      });
    }
  }
  for (const c of commentRepo.listByHabitatSince(
    habitatId,
    "1970-01-01T00:00:00.000Z",
    limit * 4,
  )) {
    if (matches(null, c.content)) {
      results.push({
        id: c.id,
        type: "comment",
        subject: c.content.slice(0, 80),
        body: c.content,
        habitatId,
        createdAt: c.createdAt,
      });
    }
  }

  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return results.slice(0, limit);
}

function filter<T>(rows: T[], predicate: (row: T) => boolean, limit: number): T[] {
  return rows.filter(predicate).slice(0, limit);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
