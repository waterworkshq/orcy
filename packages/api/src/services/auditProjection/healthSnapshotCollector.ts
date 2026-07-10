import type { AuditEvent } from "@orcy/shared/types";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { habitatHealthSnapshots } from "../../db/schema/index.js";
import type { AuditProjectionCollector } from "./types.js";

type HabitatHealthSnapshotRow = typeof habitatHealthSnapshots.$inferSelect;

function projectHealthSnapshotRow(row: HabitatHealthSnapshotRow): AuditEvent {
  return {
    id: `health_snapshot:${row.id}`,
    habitatId: row.habitatId,
    occurredAt: row.snapshotAt,
    entity: { type: "health_snapshot", id: row.id, title: `Health ${row.grade}` },
    action: "snapshot_recorded",
    actor: { type: "system", id: "system:health-engine" },
    source: "system",
    provenance: { reason: "habitat_health_snapshot" },
    linkedEntities: [],
    summary: `Habitat health snapshot recorded: ${row.grade} (${row.score})`,
    metadata: {
      score: row.score,
      grade: row.grade,
      dimensions: row.dimensions,
      metrics: row.metrics,
      recommendations: row.recommendations,
      createdAt: row.createdAt,
    },
    completeness: { status: "complete", caveats: [] },
  };
}

export const healthSnapshotCollector: AuditProjectionCollector = {
  key: "health_snapshot",
  entityTypes: ["health_snapshot"],
  failurePolicy: "warning",
  warningSource: "system",
  collect(request) {
    const sel = request.selectedEntityTypes;
    if (!sel.has("health_snapshot")) {
      return { events: [], warnings: [], caveats: [] };
    }
    const db = getDb();
    const rows = db
      .select()
      .from(habitatHealthSnapshots)
      .where(eq(habitatHealthSnapshots.habitatId, request.habitatId))
      .all() as HabitatHealthSnapshotRow[];
    const events: AuditEvent[] = rows.map(projectHealthSnapshotRow);
    return { events, warnings: [], caveats: [] };
  },
};