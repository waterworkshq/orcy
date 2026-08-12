/**
 * Stable normalized digest for extraction source observations.
 *
 * The digest is taken over the *normalized projected observation* supplied to
 * the extractor — never a retained raw payload (ADR-0044 §Polymorphic citation
 * identity). It drives `changed` detection for mutable (current-state) source
 * families: a resolver recomputes the digest and compares it with the stored
 * `source_digest`.
 *
 * Determinism requirements:
 *  - Object keys are sorted recursively so key order never affects the digest.
 *  - Arrays preserve order (order is semantically meaningful).
 *  - Numbers, booleans, null, and strings use stable `JSON.stringify` primitives.
 */
import { createHash } from "node:crypto";

/**
 * Canonicalize a value into a deterministic JSON string: object keys sorted at
 * every depth, arrays order-preserved.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).toSorted();
  const pairs = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${canonicalStringify(v)}`;
  });
  return `{${pairs.join(",")}}`;
}

/**
 * SHA-256 digest of the canonicalized input, returned as lowercase hex. Stable
 * across runs and platforms.
 */
export function computeDigest(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

/**
 * Compose a short version tag from a contract version and a set of identifying
 * fields. Used by mutable (current-state) families whose `source_version` is a
 * hash of projection contract + terminal status + finished timestamp + digest.
 */
export function composeVersion(contractVersion: string, parts: Record<string, unknown>): string {
  return computeDigest({ contractVersion, ...parts });
}
