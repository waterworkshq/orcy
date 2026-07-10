/**
 * v0.29 Phase 3/4 — collectAuditProjection + catalog coverage.
 *
 * Phase 4 registers the 3 operational collectors (automation_run, notification,
 * plugin_run) and implements the `time_record` projector in `effortCollector`.
 * The catalog now has 9 collectors and covers every `AUDIT_QUERY_ENTITY_TYPES`
 * member — `assertCatalogCoverage()` MUST pass.
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
  it("AUDIT_CATALOG is populated with 9 collectors (6 existing + 3 operational)", () => {
    expect(AUDIT_CATALOG.length).toBe(9);
  });

  it("selectCollectors filters the catalog by selected entity types", () => {
    const taskOnly = selectCollectors(new Set<AuditQueryEntityType>(["task"]));
    expect(taskOnly.map((c) => c.key)).toEqual(["lifecycle"]);

    const everything = selectCollectors(new Set(AUDIT_QUERY_ENTITY_TYPES));
    expect(everything.length).toBe(9);

    const operationalOnly = selectCollectors(
      new Set<AuditQueryEntityType>([
        "automation_run",
        "notification_event",
        "notification_delivery",
        "plugin_run",
      ]),
    );
    expect(operationalOnly.map((c) => c.key).sort()).toEqual(
      ["automation_run", "notification", "plugin_run"].sort(),
    );

    const empty = selectCollectors(new Set());
    expect(empty.length).toBe(0);
  });

  it("assertCatalogCoverage passes — every AUDIT_QUERY_ENTITY_TYPES member is claimed exactly once", () => {
    expect(() => assertCatalogCoverage()).not.toThrow();
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

  it("selects operational collectors when their entity types are explicitly requested", () => {
    const selected = selectCollectors(
      new Set<AuditQueryEntityType>([
        "automation_run",
        "notification_event",
        "notification_delivery",
        "plugin_run",
      ]),
    );
    expect(selected.map((c) => c.key).sort()).toEqual(
      ["automation_run", "notification", "plugin_run"].sort(),
    );
  });
});