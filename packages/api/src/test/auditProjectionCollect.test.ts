/**
 * v0.29 Phase 2 — collectAuditProjection skeleton test.
 *
 * With the empty catalog, the function returns `{ events: [], warnings: [], caveats: [] }`.
 * Phase 3/4 will populate the catalog; this test only proves the dispatch wiring is sound.
 */
import { describe, expect, it } from "vitest";
import { collectAuditProjection } from "../services/auditProjection/collectAuditProjection.js";
import {
  assertCatalogCoverage,
  AUDIT_CATALOG,
  selectCollectors,
} from "../services/auditProjection/catalog.js";

describe("auditProjection catalog", () => {
  it("AUDIT_CATALOG is empty in Phase 2", () => {
    expect(AUDIT_CATALOG).toHaveLength(0);
  });

  it("selectCollectors returns no collectors when AUDIT_CATALOG is empty", () => {
    const selected = selectCollectors(new Set());
    expect(selected).toHaveLength(0);
  });

  it("assertCatalogCoverage throws until Phase 3/4 populates every entity type", () => {
    expect(() => assertCatalogCoverage()).toThrow(/has no collector/);
  });
});

describe("collectAuditProjection (Phase 2 skeleton)", () => {
  it("returns empty results with empty catalog", () => {
    const result = collectAuditProjection({ habitatId: "habitat-x" });
    expect(result.events).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.caveats).toEqual([]);
  });

  it("still applies normalizeFilters (rejects taskId + missionId conflict)", () => {
    expect(() =>
      collectAuditProjection({
        habitatId: "habitat-x",
        taskId: "task-1",
        missionId: "mission-1",
      }),
    ).toThrow(/taskId and missionId cannot be combined/);
  });
});