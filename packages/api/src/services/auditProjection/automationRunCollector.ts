import type { AuditEvent, AuditWarning } from "@orcy/shared/types";
import { listForAudit } from "../../repositories/auditProjection/automationRuns.js";
import { projectAutomationRunToAudit } from "../automationAuditProjection.js";
import type { AuditProjectionCollector } from "./types.js";
import { resolveEntityReferences } from "./helpers.js";

interface TargetRef {
  type: "task" | "mission";
  id: string;
}

function readTargetRef(event: AuditEvent): TargetRef | null {
  const targetType = event.metadata.targetType;
  const targetId = event.metadata.targetId;
  if (typeof targetId !== "string" || targetId.length === 0) return null;
  if (targetType !== "task" && targetType !== "mission") return null;
  return { type: targetType, id: targetId };
}

function buildLinkedEntities(
  ref: TargetRef,
  byKey: Map<string, { ref: { type: string; id: string; title?: string | null }; owningMissionId?: string }>,
): AuditEvent["linkedEntities"] {
  const linked: AuditEvent["linkedEntities"] = [];
  const targetEntry = byKey.get(`${ref.type}:${ref.id}`);
  if (!targetEntry) return linked;
  linked.push({
    type: targetEntry.ref.type as "task" | "mission",
    id: targetEntry.ref.id,
    title: targetEntry.ref.title ?? null,
  });
  if (targetEntry.owningMissionId) {
    const owning = byKey.get(`mission:${targetEntry.owningMissionId}`);
    if (owning && !linked.some((l) => l.type === "mission" && l.id === owning.ref.id)) {
      linked.push({
        type: "mission",
        id: owning.ref.id,
        title: owning.ref.title ?? null,
      });
    }
  }
  return linked;
}

export const automationRunCollector: AuditProjectionCollector = {
  key: "automation_run",
  entityTypes: ["automation_run"],
  failurePolicy: "warning",
  warningSource: "automation",
  collect(request) {
    const rows = listForAudit(request.habitatId);
    const projectionEvents: AuditEvent[] = rows.map((row) =>
      projectAutomationRunToAudit(row.run, row.rule),
    );

    const references = projectionEvents
      .map(readTargetRef)
      .filter((ref): ref is TargetRef => ref !== null);
    const { byKey, unresolved } = resolveEntityReferences(request.habitatId, references);

    for (const event of projectionEvents) {
      const ref = readTargetRef(event);
      if (!ref) continue;
      const linked = buildLinkedEntities(ref, byKey);
      if (linked.length === 0) continue;

      const dedup = new Map<string, AuditEvent["linkedEntities"][number]>();
      for (const l of linked) dedup.set(`${l.type}:${l.id}`, l);
      event.linkedEntities = Array.from(dedup.values());
    }

    const warnings: AuditWarning[] = unresolved.map((u) => ({
      code: "automation_run_reference_unresolved",
      source: "automation",
      message: `Automation run target ${u.type}:${u.id} could not be resolved within this habitat.`,
    }));

    return { events: projectionEvents, warnings, caveats: [] };
  },
};