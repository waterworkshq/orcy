import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as pluginRunRepo from "../repositories/pluginRun.js";
import { projectPluginRunToAudit } from "../services/automationAuditProjection.js";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Plugin Audit Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

describe("projectPluginRunToAudit", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("projects a succeeded run with correct AuditEvent shape", () => {
    const habitat = setupHabitat();
    const run = pluginRunRepo.startRun({
      habitatId: habitat.id,
      pluginId: "plugin-a",
      contributionId: "detector-1",
      contributionKind: "signalDetector",
      triggerType: "task.created",
      triggerEventId: "evt-1",
    });
    pluginRunRepo.finishRun(run.id, "succeeded", 3);
    const fetched = pluginRunRepo.getById(run.id)!;

    const audit = projectPluginRunToAudit(fetched);

    expect(audit.id).toBe(`plugin_run:${run.id}`);
    expect(audit.habitatId).toBe(habitat.id);
    expect(audit.occurredAt).toBe(fetched.startedAt);
    expect(audit.source).toBe("plugin");
    expect(audit.entity).toEqual({
      type: "plugin_run",
      id: run.id,
      title: "signalDetector:detector-1 (plugin-a)",
    });
    expect(audit.action).toBe("plugin.succeeded");
    expect(audit.actor).toEqual({ type: "system", id: "plugin-a" });
    expect(audit.provenance).toEqual({
      pluginId: "plugin-a",
      contributionId: "detector-1",
      contributionKind: "signalDetector",
      triggerType: "task.created",
      runId: run.id,
    });
    expect(audit.linkedEntities).toEqual([]);
    expect(audit.summary).toBe("Plugin plugin-a detector-1 succeeded (3 signals)");
    expect(audit.metadata).toMatchObject({
      pluginId: "plugin-a",
      contributionId: "detector-1",
      contributionKind: "signalDetector",
      triggerType: "task.created",
      triggerEventId: "evt-1",
      status: "succeeded",
      signalsEmitted: 3,
    });
    expect(audit.completeness).toEqual({ status: "complete", caveats: [] });
  });

  it("projects a failed run with action plugin.failed and error in metadata", () => {
    const habitat = setupHabitat();
    const run = pluginRunRepo.startRun({
      habitatId: habitat.id,
      pluginId: "plugin-b",
      contributionId: "interceptor-1",
      contributionKind: "lifecycleInterceptor",
      triggerType: "task.updated",
    });
    pluginRunRepo.finishRun(run.id, "failed", undefined, "boom");
    const fetched = pluginRunRepo.getById(run.id)!;

    const audit = projectPluginRunToAudit(fetched);

    expect(audit.action).toBe("plugin.failed");
    expect(audit.metadata.error).toBe("boom");
    expect(audit.metadata.status).toBe("failed");
    expect(audit.summary).toContain("error: boom");
    expect(audit.completeness.status).toBe("complete");
  });

  it("projects a rate_limited run as partial completeness", () => {
    const habitat = setupHabitat();
    const run = pluginRunRepo.startRun({
      habitatId: habitat.id,
      pluginId: "plugin-c",
      contributionId: "detector-2",
      contributionKind: "signalDetector",
      triggerType: "task.created",
    });
    pluginRunRepo.finishRun(run.id, "rate_limited");
    const fetched = pluginRunRepo.getById(run.id)!;

    const audit = projectPluginRunToAudit(fetched);

    expect(audit.action).toBe("plugin.rate_limited");
    expect(audit.completeness.status).toBe("partial");
  });

  it("always sets source to 'plugin'", () => {
    const habitat = setupHabitat();
    const run = pluginRunRepo.startRun({
      habitatId: habitat.id,
      pluginId: "plugin-d",
      contributionId: "detector-3",
      contributionKind: "signalDetector",
      triggerType: "task.created",
    });
    pluginRunRepo.finishRun(run.id, "skipped");
    const fetched = pluginRunRepo.getById(run.id)!;

    const audit = projectPluginRunToAudit(fetched);

    expect(audit.source).toBe("plugin");
  });
});
