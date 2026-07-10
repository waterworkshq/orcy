import type { AuditEvent } from "@orcy/shared/types";
import { listForAudit } from "../../repositories/auditProjection/automationRuns.js";
import { projectAutomationRunToAudit } from "../automationAuditProjection.js";
import type { AuditProjectionCollector } from "./types.js";

export const automationRunCollector: AuditProjectionCollector = {
  key: "automation_run",
  entityTypes: ["automation_run"],
  failurePolicy: "warning",
  warningSource: "automation",
  collect(request) {
    const rows = listForAudit(request.habitatId);
    const events: AuditEvent[] = rows.map((row) =>
      projectAutomationRunToAudit(row.run, row.rule),
    );
    return { events, warnings: [], caveats: [] };
  },
};