/**
 * Occurrence canonicalization — deterministic JCS-style canonical JSON plus
 * SHA-256 identity derivation for triage publication occurrences.
 *
 * The restored Finding Triage plan specifies versioned JCS (JSON
 * Canonicalization Scheme) + SHA-256 for occurrence identity. This module
 * implements a MINIMAL deterministic canonicalization rather than vendoring a
 * full RFC 8785 implementation:
 *
 *   - Objects: keys sorted recursively in UTF-16 code-unit order (JCS §3.2.3),
 *     serialized with `JSON.stringify` (no whitespace).
 *   - Arrays: ORDER PRESERVED (JCS preserves array order); callers sort
 *     semantically-ordered collections (Pulse ids, identities) BEFORE
 *     serialization.
 *   - Strings: native `JSON.stringify` escaping (control chars, quotes,
 *     backslash) — identical to JCS for the BMP subset this data occupies.
 *   - Numbers: only integers appear in canonicalized shapes (version, order).
 *
 * Collision safety (the load-bearing property): every canonicalized value is a
 * STRICTLY-SHAPED, TYPED JSON object — never a delimiter-joined string. JSON's
 * structural typing means ambiguous strings (`"a|b"` vs `"b|c"` splits,
 * key/value confusions, embedded delimiters) serialize to structurally
 * distinct documents and can never collide. The collision discriminators in
 * `triageOccurrencePublication.test.ts` prove this against deliberately
 * ambiguous inputs.
 *
 * Identity is version-prefixed (`tpo-v1:`) so a future snapshot-shape change
 * derives a fresh id space instead of aliasing old occurrences.
 */
import { createHash } from "crypto";

/** Current occurrence identity schema version (part of the id prefix). */
export const OCCURRENCE_IDENTITY_VERSION = 1;

/** Canonical occurrence id prefix: `tpo-v1:` + sha256 hex of the snapshot. */
const OCCURRENCE_ID_PREFIX = `tpo-v${OCCURRENCE_IDENTITY_VERSION}:`;

/**
 * Deterministic canonical JSON (minimal JCS): recursively key-sorted,
 * no-whitespace serialization. Array order preserved.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Recursively sorts object keys (arrays untouched). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 hex digest of a string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Derives the canonical digest + versioned occurrence id from a snapshot object. */
export function deriveOccurrenceIdentity(snapshot: unknown): {
  occurrenceId: string;
  snapshotDigest: string;
  canonicalSnapshot: string;
} {
  const canonicalSnapshot = canonicalJson(snapshot);
  const snapshotDigest = sha256Hex(canonicalSnapshot);
  return {
    occurrenceId: `${OCCURRENCE_ID_PREFIX}${snapshotDigest}`,
    snapshotDigest,
    canonicalSnapshot,
  };
}

/** Canonical template-definition snapshot (provenance digest input). */
export function templateProvenanceDigest(template: {
  id: string;
  titlePattern: string;
  descriptionPattern: string;
  priority: string;
  labels: string[];
  tasksTemplate: unknown;
  workflowTemplate: unknown;
}): string {
  return sha256Hex(canonicalJson({ ...template }));
}
