/**
 * v0.29 Phase 3 — collectAuditProjection + catalog coverage.
 *
 * The catalog is populated by Phase 3 with the existing families (lifecycle,
 * effort, code_evidence, integration_sync, webhook_delivery, health_snapshot).
 * `assertCatalogCoverage` still throws because operational types
 * (automation_run, notification_event, notification_delivery, plugin_run) are
 * added in Phase 4.
 */
import { describe, expect, it } from "vitest";
import { collectAuditProjection } from "../services/auditProjection/collectAuditProjection.js";
import {
  assertCatalogCoverage,
  AUDIT_CATALOG,
  selectCollectors,
} from "../services/auditProjection/catalog.js";
import {
  AUDIT_QUERY_ENTITY_TYPES,
  type AuditQueryEntityType,
} from "@orcy/shared/types";

describe("auditProjection catalog", () => {
  it("AUDIT_CATALOG is populated in Phase 3 with 6 existing-family collectors", () => {
    expect(AUDIT_CATALOG.length).toBe(6);
  });

  it("selectCollectors filters the catalog by selected entity types", () => {
    const taskOnly = selectCollectors(new Set<AuditQueryEntityType>(["task"]));
    expect(taskOnly.map((c) => c.key)).toEqual(["lifecycle"]);

    const everything = selectCollectors(new Set(AUDIT_QUERY_ENTITY_TYPES));
    expect(everything.length).toBe(6);

    const empty = selectCollectors(new Set());
    expect(empty.length).toBe(0);
  });

  it("assertCatalogCoverage throws until Phase 4 adds operational collectors", () => {
    expect(() => assertCatalogCoverage()).toThrow(/has no collector/);
  });
});

describe("collectAuditProjection", () => {
  it("applies normalizeFilters (rejects taskId + missionId conflict)", () => {
    expect(() =>
      collectAuditProjection({
        habitatId: "habitat-x",
        taskId: "task-1",
        missionId: "mission-1",
      }),
    ).toThrow(/taskId and missionId cannot be combined/);
  });

  it("selects no collectors when entityType is unknown and no includeHealthSnapshots", () => {
    expect(
      selectCollectors(
        new Set<AuditQueryEntityType>([
          "automation_run",
          "notification_event",
          "notification_delivery",
          "plugin_run",
        ]),
      ),
    ).toEqual([]);
  });
});