/**
 * Phase 6 — reference plugin behavior tests.
 *
 * Loads the ACTUAL reference plugin modules at `plugins/auto-label/index.ts`
 * and `plugins/teams-channel/index.ts` and exercises their handlers directly
 * with constructed contexts. This validates the shipped plugin code paths
 * (handler shape, regex rules, env gating) rather than a test-local copy.
 *
 * The handlers are invoked directly (not via the dispatcher) so the assertions
 * target the plugin's own logic — the dispatcher plumbing is covered by
 * `channelRegistry.test.ts` and `lifecycleInterceptor.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type {
  PluginModule,
  PluginContext,
  NotificationPayload,
  EventSourceRef,
} from "../plugins/types.js";
import type { NotificationEvent, NotificationDelivery, Pulse } from "@orcy/shared";
import type { Task } from "../models/index.js";

const REPO_ROOT = resolve(__dirname, "../../../../");
const autoLabelUrl = pathToFileURL(resolve(REPO_ROOT, "plugins/auto-label/index.ts")).href;
const teamsChannelUrl = pathToFileURL(resolve(REPO_ROOT, "plugins/teams-channel/index.ts")).href;
const detectorFrustrationUrl = pathToFileURL(
  resolve(REPO_ROOT, "plugins/detector-regex-frustration/index.ts"),
).href;

async function loadPlugin(url: string): Promise<PluginModule> {
  const mod = (await import(url)) as { default: PluginModule };
  return mod.default;
}

function buildCtx(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    pluginId: "test-plugin",
    contributionId: "test",
    habitatId: "hab-1",
    runId: "run-1",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    audit: { log: vi.fn() },
    ...overrides,
  };
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    missionId: "mission-1",
    title: "placeholder",
    status: "pending",
    priority: "medium",
    labels: [],
    createdBy: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Task;
}

describe("reference plugin: auto-label (lifecycleInterceptor, post taskCreated)", () => {
  let autoLabel: PluginModule;

  beforeEach(async () => {
    autoLabel = await loadPlugin(autoLabelUrl);
  });

  it("manifest declares the lifecycleInterceptor contribution correctly", () => {
    expect(autoLabel.manifest.id).toBe("auto-label");
    expect(autoLabel.manifest.contributions).toHaveLength(1);
    const c = autoLabel.manifest.contributions[0];
    expect(c.kind).toBe("lifecycleInterceptor");
    if (c.kind !== "lifecycleInterceptor") return;
    expect(c.phase).toBe("post");
    expect(c.event).toBe("taskCreated");
    expect(c.interceptorId).toBe("auto-label-suggest");
    expect(c.requires).toContain("pulseWriter");
  });

  it("emits a detected signal with the 'bug' label for a 'fix: crash in userService' title", () => {
    const handler = autoLabel.interceptors!["auto-label-suggest"];
    const ctx = buildCtx();
    const transition = {
      taskId: "task-1",
      action: "taskCreated" as const,
      habitatId: "hab-1",
      context: { task: buildTask({ title: "fix: crash in userService" }) },
    };

    const result = handler(ctx, transition) as { signals?: unknown[] };

    expect(result.signals).toBeDefined();
    expect(result.signals).toHaveLength(1);
    const signal = result.signals![0] as {
      signalType: string;
      subject: string;
      body: string;
      metadata: { labels: string[] };
    };
    expect(signal.signalType).toBe("detected");
    expect(signal.subject).toContain("Auto-label");
    expect(signal.metadata.labels).toContain("bug");
  });

  it("emits no signal for a title that matches no label rule", () => {
    const handler = autoLabel.interceptors!["auto-label-suggest"];
    const ctx = buildCtx();
    const transition = {
      taskId: "task-1",
      action: "taskCreated" as const,
      habitatId: "hab-1",
      context: { task: buildTask({ title: "hello world" }) },
    };

    const result = handler(ctx, transition) as { signals?: unknown[] };
    // No labels matched — handler returns `{}` (no signals key).
    expect(result.signals).toBeUndefined();
  });

  it("handler is synchronous (returns InterceptorPostResult, not a Promise)", () => {
    const handler = autoLabel.interceptors!["auto-label-suggest"];
    const ctx = buildCtx();
    const transition = {
      taskId: "task-1",
      action: "taskCreated" as const,
      habitatId: "hab-1",
      context: { task: buildTask({ title: "fix bug" }) },
    };
    const result = handler(ctx, transition);
    // A Promise would have `.then`; a plain object would not.
    expect(result).not.toHaveProperty("then");
  });
});

describe("reference plugin: teams-channel (notificationChannel via webhook)", () => {
  let teamsChannel: PluginModule;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    teamsChannel = await loadPlugin(teamsChannelUrl);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.ORCY_TEAMS_WEBHOOK_URL;
  });

  function buildPayload(
    overrides: Partial<{
      delivery: Partial<NotificationDelivery>;
      event: Partial<NotificationEvent>;
    }> = {},
  ): NotificationPayload {
    return {
      delivery: {
        id: "del-1",
        habitatId: "hab-1",
        eventId: "evt-1",
        recipientType: "human",
        recipientId: "user-1",
        channels: ["in_app"],
        status: "pending",
        createdAt: new Date().toISOString(),
        ...overrides.delivery,
      } as NotificationDelivery,
      event: {
        id: "evt-1",
        habitatId: "hab-1",
        eventType: "task.assigned",
        sourceType: "task",
        sourceId: "task-1",
        severity: "info",
        title: "Build broken",
        body: "CI failed on main",
        createdByType: "system",
        createdAt: new Date().toISOString(),
        ...overrides.event,
      } as NotificationEvent,
    };
  }

  it("manifest declares the notificationChannel contribution correctly", () => {
    expect(teamsChannel.manifest.id).toBe("teams-channel");
    expect(teamsChannel.manifest.contributions).toHaveLength(1);
    const c = teamsChannel.manifest.contributions[0];
    expect(c.kind).toBe("notificationChannel");
    if (c.kind !== "notificationChannel") return;
    expect(c.channelId).toBe("teams");
    expect(c.scope).toBe("system");
    expect(c.requires).toEqual([]);
  });

  it("returns {success:false} when ORCY_TEAMS_WEBHOOK_URL is not configured", async () => {
    delete process.env.ORCY_TEAMS_WEBHOOK_URL;
    const handler = teamsChannel.channels!.teams;
    const result = await handler(buildCtx(), buildPayload());
    expect(result.success).toBe(false);
    expect(result.error).toContain("ORCY_TEAMS_WEBHOOK_URL");
  });

  it("POSTs an Adaptive Card to the webhook and returns {success:true} on 2xx", async () => {
    process.env.ORCY_TEAMS_WEBHOOK_URL = "https://hooks.example.test/incoming";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const handler = teamsChannel.channels!.teams;
    const payload = buildPayload({
      event: {
        title: "Build broken",
        body: "CI failed",
        eventType: "task.blocked",
        severity: "critical",
      },
    });
    const result = await handler(buildCtx(), payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.test/incoming");
    expect(init).toMatchObject({ method: "POST" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body["@type"]).toBe("MessageCard");
    expect(body.title).toBe("Build broken");
    expect(body.text).toBe("CI failed");

    expect(result.success).toBe(true);
  });

  it("returns {success:false, statusCode} when the webhook responds non-2xx", async () => {
    process.env.ORCY_TEAMS_WEBHOOK_URL = "https://hooks.example.test/incoming";
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 } as Response);
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const handler = teamsChannel.channels!.teams;
    const result = await handler(buildCtx(), buildPayload());
    expect(result.success).toBe(false);
    expect(result.error).toContain("429");
    expect(result.statusCode).toBe(429);
  });

  it("returns {success:false} when fetch throws (network error)", async () => {
    process.env.ORCY_TEAMS_WEBHOOK_URL = "https://hooks.example.test/incoming";
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const handler = teamsChannel.channels!.teams;
    const result = await handler(buildCtx(), buildPayload());
    expect(result.success).toBe(false);
    expect(result.error).toBe("Teams webhook request failed");
  });
});

describe("reference plugin: detector-regex-frustration (signalDetector, detects pulseCreated)", () => {
  let detector: PluginModule;

  beforeEach(async () => {
    detector = await loadPlugin(detectorFrustrationUrl);
  });

  function buildPulse(overrides: Partial<Pulse> = {}): Pulse {
    return {
      id: "pulse-1",
      missionId: null,
      habitatId: "hab-1",
      scope: "habitat",
      fromType: "agent",
      fromId: "agent-1",
      toType: null,
      toId: null,
      signalType: "experience",
      subject: "status update",
      body: "all good",
      taskId: null,
      replyToId: null,
      linkedTaskId: null,
      metadata: {},
      createdAt: new Date().toISOString(),
      pinned: 0,
      isAuto: false,
      ...overrides,
    } as Pulse;
  }

  function buildSource(overrides: Partial<EventSourceRef> = {}): EventSourceRef {
    return {
      kind: "pulseCreated",
      sourceId: "pulse-1",
      habitatId: "hab-1",
      occurredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("manifest declares the signalDetector contribution correctly", () => {
    expect(detector.manifest.id).toBe("detector-regex-frustration");
    expect(detector.manifest.contributions).toHaveLength(1);
    const c = detector.manifest.contributions[0];
    expect(c.kind).toBe("signalDetector");
    if (c.kind !== "signalDetector") return;
    expect(c.scope).toBe("habitat");
    expect(c.detectorId).toBe("regex-frustration");
    expect(c.detects).toBe("pulseCreated");
    expect(c.requires).toEqual(["pulseReader", "pulseWriter"]);
    expect(c.rateLimitDefaults).toEqual({ maxDetectionsPerMinute: 30, maxSignalsPerHour: 200 });
  });

  it("emits a detected signal with categories when the pulse body matches a frustration pattern", async () => {
    const handler = detector.detectors!["regex-frustration"];
    const pulseReader = {
      getPulse: vi
        .fn()
        .mockResolvedValue(
          buildPulse({ subject: "dependency problems", body: "this dependency is hell" }),
        ),
    };
    const ctx = buildCtx({ pulseReader: pulseReader as never });
    const result = await handler(ctx, buildSource());

    expect(pulseReader.getPulse).toHaveBeenCalledWith("pulse-1");
    expect(result).toHaveLength(1);
    const signal = result[0];
    expect(signal.signalType).toBe("detected");
    expect(signal.subject).toContain("Frustration detected");
    expect(signal.metadata?.categories).toEqual(["dependency_hell"]);
    expect(signal.metadata?.sourcePulseId).toBe("pulse-1");
  });

  it("returns [] for a pulse whose text matches no frustration pattern", async () => {
    const handler = detector.detectors!["regex-frustration"];
    const pulseReader = {
      getPulse: vi
        .fn()
        .mockResolvedValue(
          buildPulse({ subject: "shipping the feature", body: "all tests green" }),
        ),
    };
    const ctx = buildCtx({ pulseReader: pulseReader as never });
    const result = await handler(ctx, buildSource());
    expect(result).toEqual([]);
  });

  it("returns [] when pulseReader is absent (defensive — loader always provides it)", async () => {
    const handler = detector.detectors!["regex-frustration"];
    const ctx = buildCtx({ pulseReader: undefined });
    const result = await handler(ctx, buildSource());
    expect(result).toEqual([]);
  });

  it("returns [] when getPulse resolves null (pulse no longer exists)", async () => {
    const handler = detector.detectors!["regex-frustration"];
    const pulseReader = { getPulse: vi.fn().mockResolvedValue(null) };
    const ctx = buildCtx({ pulseReader: pulseReader as never });
    const result = await handler(ctx, buildSource());
    expect(result).toEqual([]);
  });

  it("returns [] when the source pulse is itself a detected signal (recursion guard)", async () => {
    const handler = detector.detectors!["regex-frustration"];
    const pulseReader = {
      getPulse: vi
        .fn()
        .mockResolvedValue(buildPulse({ signalType: "detected", body: "this dependency is hell" })),
    };
    const ctx = buildCtx({ pulseReader: pulseReader as never });
    const result = await handler(ctx, buildSource());
    expect(result).toEqual([]);
  });

  it("aggregates multiple matched categories into a single signal", async () => {
    const handler = detector.detectors!["regex-frustration"];
    const pulseReader = {
      getPulse: vi.fn().mockResolvedValue(
        buildPulse({
          subject: "this is so frustrating",
          body: "why does this always break — what a waste of time",
        }),
      ),
    };
    const ctx = buildCtx({ pulseReader: pulseReader as never });
    const result = await handler(ctx, buildSource());
    expect(result).toHaveLength(1);
    const categories = result[0].metadata?.categories as string[];
    expect(categories).toEqual(
      expect.arrayContaining(["frustration", "repeated_breakage", "time_waste"]),
    );
    expect(categories).toHaveLength(3);
  });
});
