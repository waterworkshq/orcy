/**
 * Shared helpers for extraction source adapters.
 *
 * Boundary capture, window filtering, observation-ID minting, source-ID parsing,
 * and the closed exclusion vocabulary. These are internal to the catalog; nothing
 * here is part of the public adapter interface.
 */
import type { ExtractionSourceType } from "@orcy/shared";
import type { SourceBoundaryToken, SourceWindowRequest } from "./types.js";

/**
 * Closed set of audit entity types the Learning Loop must NEVER collect
 * (feedback-loop prevention — authorization-review §Feedback-loop prevention #1).
 * The catalog families are `task`/`mission`/`automation_run`/`plugin_run`/
 * `triage_resolution` projections; none of these extraction entities are ever
 * admitted.
 */
export const EXCLUDED_AUDIT_ENTITY_TYPES = new Set([
  "extraction_work_item",
  "extraction_attempt",
  "extracted_finding",
]);

/** Audit source provenance excluded from every source batch. */
export const EXCLUDED_AUDIT_SOURCE = "learning_loop";

/** The earliest representable ISO timestamp (used when a source is empty). */
export const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** Mint an opaque batch-local observation ID from the underlying row ID. */
export function mintObservationId(sourceType: string, underlyingId: string): string {
  return `obs:${sourceType}:${underlyingId}`;
}

/** Build a boundary token capturing a high-water mark. */
export function makeBoundaryToken(
  sourceType: ExtractionSourceType,
  highWaterMark: string,
): SourceBoundaryToken {
  return {
    sourceType,
    highWaterMark,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Window + boundary predicate. A row is admitted to the current batch only when
 * its `occurredAt` is within `[windowFrom, windowTo)` AND at or below the
 * captured `highWaterMark`. Rows arriving after capture wait for later work.
 */
export function isWithinWindow(
  occurredAt: string,
  request: SourceWindowRequest,
  highWaterMark: string,
): boolean {
  if (occurredAt < request.windowFrom) return false;
  if (request.windowTo !== undefined && occurredAt >= request.windowTo) return false;
  return occurredAt <= highWaterMark;
}

/** Strip a known `prefix:` from a source ID, returning the underlying ID. */
export function parseUnderlyingId(sourceId: string, prefix: string): string | null {
  const head = `${prefix}:`;
  if (!sourceId.startsWith(head)) return null;
  const rest = sourceId.slice(head.length);
  return rest.length > 0 ? rest : null;
}
