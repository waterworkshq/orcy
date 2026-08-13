/**
 * Extraction source catalog — total adapter registry.
 *
 * Mirrors the audit-projection catalog totality discipline
 * (`auditProjection/catalog.ts`): a frozen readonly array, a selector, and an
 * `assertExtractionCatalogCoverage()` that throws if any `EXTRACTION_SOURCE_TYPES`
 * lacks an adapter or two adapters claim the same type. The assertion runs at
 * module load so a misconfigured catalog fails fast.
 *
 * The runner (ticket 4) accepts only catalog output. Adapters return
 * observations with opaque batch-local IDs that extractors cite; the downstream
 * validator rejects zero-citation, fabricated-ID, cross-Habitat, and
 * policy-excluded candidates.
 */
import { EXTRACTION_SOURCE_TYPES, type ExtractionSourceType } from "@orcy/shared";
import { automationRunAuditAdapter } from "./adapters/automationRunAudit.js";
import { experienceAggregateAdapter } from "./adapters/experienceAggregate.js";
import { missionLifecycleAuditAdapter } from "./adapters/missionLifecycleAudit.js";
import { pluginRunAuditAdapter } from "./adapters/pluginRunAudit.js";
import { taskLifecycleAuditAdapter } from "./adapters/taskLifecycleAudit.js";
import { triageResolutionAdapter } from "./adapters/triageResolution.js";
import type { ExtractionSourceAdapter } from "./types.js";

/**
 * Frozen total registry: exactly one adapter per `EXTRACTION_SOURCE_TYPES`.
 * Order is stable; do not mutate.
 */
export const EXTRACTION_SOURCE_CATALOG: readonly ExtractionSourceAdapter[] = Object.freeze([
  taskLifecycleAuditAdapter,
  missionLifecycleAuditAdapter,
  automationRunAuditAdapter,
  pluginRunAuditAdapter,
  triageResolutionAdapter,
  experienceAggregateAdapter,
]);

/** Index for O(1) adapter lookup by source type. */
const ADAPTER_BY_TYPE: ReadonlyMap<ExtractionSourceType, ExtractionSourceAdapter> = new Map(
  EXTRACTION_SOURCE_CATALOG.map((adapter) => [adapter.type, adapter]),
);

/**
 * Select adapters whose type is in `selectedSourceTypes`. An empty selection
 * returns every adapter (mirrors the audit collector convention).
 */
export function selectAdapters(
  selectedSourceTypes: ReadonlySet<ExtractionSourceType>,
): readonly ExtractionSourceAdapter[] {
  if (!selectedSourceTypes.size) return EXTRACTION_SOURCE_CATALOG;
  return EXTRACTION_SOURCE_CATALOG.filter((adapter) => selectedSourceTypes.has(adapter.type));
}

/** Look up the adapter for one source type. Throws if none is registered. */
export function getAdapter(sourceType: ExtractionSourceType): ExtractionSourceAdapter {
  const adapter = ADAPTER_BY_TYPE.get(sourceType);
  if (!adapter) {
    throw new Error(`Extraction source catalog: no adapter registered for "${sourceType}".`);
  }
  return adapter;
}

/**
 * Enforce catalog totality: every `EXTRACTION_SOURCE_TYPES` must have exactly
 * one adapter, and no two adapters may claim the same type. Mirrors
 * `assertCatalogCoverage` in the audit-projection catalog.
 *
 * Pure variant: validates any registry against the closed vocabulary. Exposed
 * for tests that prove removing or duplicating an adapter fails the assertion.
 */
export function validateCatalogCoverage(registry: readonly ExtractionSourceAdapter[]): void {
  const claimed = new Set<ExtractionSourceType>();
  for (const adapter of registry) {
    if (claimed.has(adapter.type)) {
      throw new Error(
        `Extraction source catalog: source type "${adapter.type}" is claimed by multiple adapters.`,
      );
    }
    claimed.add(adapter.type);
  }
  for (const sourceType of EXTRACTION_SOURCE_TYPES) {
    if (!claimed.has(sourceType)) {
      throw new Error(`Extraction source catalog: source type "${sourceType}" has no adapter.`);
    }
  }
}

/**
 * Enforce totality of the live {@link EXTRACTION_SOURCE_CATALOG}. Called at
 * module load; throws on violation.
 */
export function assertExtractionCatalogCoverage(): void {
  validateCatalogCoverage(EXTRACTION_SOURCE_CATALOG);
}

// Fail fast at module load if the registry is misconfigured.
assertExtractionCatalogCoverage();
