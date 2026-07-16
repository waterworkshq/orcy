import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
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

  it("projects a succeeded run with typed plugin provenance", () => {
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
    expect(audit.occurredAt).toBe(fetched.finishedAt ?? fetched.startedAt);
    expect(audit.source).toBe("plugin");
    expect(audit.entity).toEqual({
      type: "plugin_run",
      id: run.id,
      title: "signalDetector:detector-1 (plugin-a)",
    });
    expect(audit.action).toBe("plugin.succeeded");
    expect(audit.actor).toEqual({ type: "system", id: "plugin-a" });
    expect(audit.provenance).toEqual({
      plugin: {
        runId: run.id,
        pluginId: "plugin-a",
        contributionId: "detector-1",
        contributionKind: "signalDetector",
        triggerType: "task.created",
        status: "succeeded",
      },
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
      hasError: false,
    });
    expect(audit.metadata.error).toBeUndefined();
    expect(audit.metadata.fingerprint).toBeUndefined();
    expect(audit.completeness).toEqual({ status: "complete", caveats: [] });
  });

  it("projects a failed run with hasError boolean (no error text)", () => {
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
    expect(audit.metadata.status).toBe("failed");
    expect(audit.metadata.hasError).toBe(true);
    expect(audit.metadata.error).toBeUndefined();
    expect(audit.summary).not.toContain("boom");
    expect(audit.completeness.status).toBe("complete");
  });

  it("projects a rate_limited run as complete (no more partial branch)", () => {
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
    expect(audit.completeness.status).toBe("complete");
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

  it("normalizes unknown contributionKind to 'unknown' in provenance, retains original in metadata", () => {
    const habitat = setupHabitat();
    const run = pluginRunRepo.startRun({
      habitatId: habitat.id,
      pluginId: "plugin-e",
      contributionId: "detector-x",
      contributionKind: "obsoleteKind",
      triggerType: "task.created",
    });
    pluginRunRepo.finishRun(run.id, "succeeded", 1);
    const fetched = pluginRunRepo.getById(run.id)!;

    const audit = projectPluginRunToAudit(fetched);

    expect(audit.provenance.plugin?.contributionKind).toBe("unknown");
    expect(audit.metadata.contributionKind).toBe("obsoleteKind");
  });
});