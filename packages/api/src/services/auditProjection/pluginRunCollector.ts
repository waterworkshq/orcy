import type { AuditEvent } from "@orcy/shared/types";
import { listForAudit } from "../../repositories/auditProjection/pluginRuns.js";
import { projectPluginRunToAudit } from "../automationAuditProjection.js";
import type { AuditProjectionCollector } from "./types.js";

export const pluginRunCollector: AuditProjectionCollector = {
  key: "plugin_run",
  entityTypes: ["plugin_run"],
  failurePolicy: "warning",
  warningSource: "plugin",
  collect(request) {
    const rows = listForAudit(request.habitatId);
    const events: AuditEvent[] = rows.map((row) => projectPluginRunToAudit(row));
    return { events, warnings: [], caveats: [] };
  },
};