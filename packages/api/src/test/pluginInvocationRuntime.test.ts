/**
 * ADR-0039 T3 — Plugin Invocation Runtime foundation suite.
 *
 * Table-driven coverage of the five validators, the fault-accounting policy
 * matrix, the synchronous pre-veto lifecycle, the asynchronous managed
 * lifecycle, and the start/finish failure contract. All tests exercise the
 * runtime through mock `RuntimeDeps` — no production dispatch path is migrated.
 *
 * Acceptance criteria verified:
 *   - Two entry points and typed target/outcome unions compile.       (structural)
 *   - Five validators reject null, malformed discriminators, invalid    (validators)
 *     arrays/signals, and invalid field combinations — including arrays.
 *   - Promise return on synchronous pre is classified as runtime fault. (pre-veto)
 *   - Expected domain failures never increment; eligible runtime faults do. (policy)
 *   - start/finish repository failures are distinguishable in tests.    (failure)
 *   - No production dispatch behavior changes.                          (additive)
 *
 * Review-fix coverage (BLOCKER 1-3, MAJOR 1-6):
 *   - onResult side-effect hook runs before finishRun.                 (BLOCKER 1)
 *   - Context/handler invocation inside try — no leaked runs/slots.    (BLOCKER 2)
 *   - Rejected handlerPromise does not fire unhandledRejection.        (BLOCKER 3)
 *   - Rejected sync-pre Promise consumed.                              (MAJOR 1)
 *   - Validators reject arrays (isPlainObject guard).                  (MAJOR 2)
 *   - Action validator rejects succeeded+error / failed+result.        (MAJOR 3)
 *   - Helpers do not overwrite per-test handlers.                      (MAJOR 4)
 *   - finishRun null return treated as failure.                        (MAJOR 6)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createInvocationRuntime,
  validateDetectorResult,
  validateActionResult,
  validateChannelResult,
  validatePreResult,
  validatePostResult,
  INVOCATION_POLICY,
  contributionKindForStorage,
  type RuntimeDeps,
  type InvocationRuntime,
  type PreVetoRequest,
  type ManagedInvocationRequest,
  type DetectorTarget,
  type ActionTarget,
  type ChannelTarget,
  type PostInterceptorTarget,
  type PreInterceptorTarget,
  type DetectorInvocationRequest,
  type ActionInvocationRequest,
  type ChannelInvocationRequest,
  type PostInterceptorInvocationRequest,
} from "../plugins/invocationRuntime.js";
import type { PluginRunStatus } from "../repositories/pluginRun.js";
import type { PluginRunRow } from "../db/schema/index.js";
import type { InterceptorEvent, PluginEvaluationContext, DetectedSignalInput } from "@orcy/shared";

// ─────────────────────────────────────────────────────────────────────────────
// Mock infrastructure
// ─────────────────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return {
    startRun:
      overrides.startRun ??
      vi.fn((input: unknown): PluginRunRow => {
        const i = input as {
          habitatId: string;
          pluginId: string;
          contributionId: string;
          contributionKind: string;
        };
        return {
          id: `run-${Math.random().toString(36).slice(2, 10)}`,
          habitatId: i.habitatId,
          pluginId: i.pluginId,
          contributionId: i.contributionId,
          contributionKind: i.contributionKind,
          triggerEventId: null,
          triggerType: "test",
          status: "running",
          fingerprint: "fp",
          signalsEmitted: null,
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        } as PluginRunRow;
      }),
    finishRun:
      overrides.finishRun ??
      vi.fn(
        (id: string, status: PluginRunStatus): PluginRunRow | null =>
          ({
            id,
            status,
          }) as PluginRunRow,
      ),
    deleteRun: overrides.deleteRun ?? vi.fn((): boolean => true),
    buildContext:
      overrides.buildContext ??
      ((opts: {
        pluginId: string;
        contributionId: string;
        habitatId: string;
        runId: string;
        requires: unknown[];
      }) => ({
        pluginId: opts.pluginId,
        contributionId: opts.contributionId,
        habitatId: opts.habitatId,
        runId: opts.runId,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        audit: { log: vi.fn() },
      })),
    isQuarantined: overrides.isQuarantined ?? (() => false),
    incrementError: overrides.incrementError ?? vi.fn(),
    withTimeout: overrides.withTimeout ?? (<T>(p: Promise<T>) => p),
    acquireDetectorSlot: overrides.acquireDetectorSlot ?? (() => true),
    releaseDetectorSlot: overrides.releaseDetectorSlot ?? vi.fn(),
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
}

function makeRuntime(overrides?: Partial<RuntimeDeps>): {
  runtime: InvocationRuntime;
  deps: RuntimeDeps;
} {
  const deps = makeDeps(overrides);
  return { runtime: createInvocationRuntime(deps), deps };
}

// ─────────────────────────────────────────────────────────────────────────────
// Target fixtures (handlers are set per-test, NOT in fixtures — MAJOR 4)
// ─────────────────────────────────────────────────────────────────────────────

const detectorTarget: DetectorTarget = {
  kind: "signalDetector",
  pluginId: "plugin-a",
  contributionId: "det-1",
  handler: vi.fn(),
  requires: [],
  timeoutMs: 0,
  canonicalKey: '["signalDetector","plugin-a","det-1"]',
  contribution: {
    kind: "signalDetector",
    detectorId: "det-1",
    detects: "pulseCreated",
    requires: [],
  } as unknown as DetectorTarget["contribution"],
};

const actionTarget: ActionTarget = {
  kind: "automationAction",
  pluginId: "plugin-b",
  contributionId: "act-1",
  handler: vi.fn(),
  requires: [],
  timeoutMs: 0,
  canonicalKey: '["automationAction","plugin-b","act-1"]',
  contribution: {
    kind: "automationAction",
    actionId: "act-1",
    requires: [],
  } as unknown as ActionTarget["contribution"],
};

const channelTarget: ChannelTarget = {
  kind: "notificationChannel",
  pluginId: "plugin-c",
  contributionId: "ch-1",
  handler: vi.fn(),
  requires: [],
  timeoutMs: 0,
  canonicalKey: '["notificationChannel","plugin-c","ch-1"]',
  contribution: {
    kind: "notificationChannel",
    channelId: "ch-1",
    requires: [],
  } as unknown as ChannelTarget["contribution"],
};

const postTarget: PostInterceptorTarget = {
  kind: "postInterceptor",
  pluginId: "plugin-d",
  contributionId: "int-1",
  handler: vi.fn(),
  requires: [],
  timeoutMs: 0,
  canonicalKey: '["lifecycleInterceptor","plugin-d","int-1","post","taskCreated"]',
  contribution: {
    kind: "lifecycleInterceptor",
    interceptorId: "int-1",
    phase: "post",
    event: "taskCreated",
    priority: 0,
    requires: [],
  } as unknown as PostInterceptorTarget["contribution"],
};

const preTarget: PreInterceptorTarget = {
  kind: "preInterceptor",
  pluginId: "plugin-e",
  contributionId: "int-pre",
  handler: vi.fn(),
  requires: [],
  timeoutMs: 0,
  canonicalKey: '["lifecycleInterceptor","plugin-e","int-pre","pre","taskCreated"]',
  contribution: {
    kind: "lifecycleInterceptor",
    interceptorId: "int-pre",
    phase: "pre",
    event: "taskCreated",
    priority: 0,
    requires: [],
  } as unknown as PreInterceptorTarget["contribution"],
};

const evalCtx = {
  habitat: null,
  task: null,
  mission: null,
  agent: null,
  sprint: null,
  raw: {},
} as PluginEvaluationContext;
const validSignal: DetectedSignalInput = { signalType: "detected", subject: "test signal" };

// ─── Request builders — pure, do NOT install handlers (MAJOR 4) ───

function detectorReq(overrides?: Partial<DetectorInvocationRequest>): ManagedInvocationRequest {
  return {
    target: detectorTarget,
    habitatId: "hab-1",
    triggerEventId: "pulse-1",
    triggerType: "pulseCreated",
    source: { kind: "pulseCreated", sourceId: "pulse-1", habitatId: "hab-1", occurredAt: "" },
    ...overrides,
  };
}

function actionReq(overrides?: Partial<ActionInvocationRequest>): ManagedInvocationRequest {
  return {
    target: actionTarget,
    habitatId: "hab-1",
    triggerType: "automation:plugin-action",
    evalCtx,
    params: {},
    ...overrides,
  };
}

function channelReq(overrides?: Partial<ChannelInvocationRequest>): ManagedInvocationRequest {
  return {
    target: channelTarget,
    habitatId: "hab-1",
    triggerEventId: "evt-1",
    triggerType: "channel:ch-1",
    delivery: { id: "d1", habitatId: "hab-1" } as unknown as ChannelInvocationRequest["delivery"],
    event: { type: "taskCreated" } as unknown as ChannelInvocationRequest["event"],
    ...overrides,
  };
}

function postReq(overrides?: Partial<PostInterceptorInvocationRequest>): ManagedInvocationRequest {
  return {
    target: postTarget,
    habitatId: "hab-1",
    triggerEventId: "task-1",
    triggerType: "taskCreated:post",
    taskId: "task-1",
    event: "taskCreated" as InterceptorEvent,
    context: {},
    ...overrides,
  };
}

function preReq(handler: (ctx: unknown, t: unknown) => unknown): PreVetoRequest {
  preTarget.handler = handler as PreInterceptorTarget["handler"];
  return {
    target: preTarget,
    taskId: "task-1",
    event: "taskCreated" as InterceptorEvent,
    habitatId: "hab-1",
    context: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy catalog
// ─────────────────────────────────────────────────────────────────────────────

describe("INVOCATION_POLICY", () => {
  it("Detector: faults count, 5s default timeout", () => {
    expect(INVOCATION_POLICY.signalDetector).toEqual({
      faultsCountTowardQuarantine: true,
      defaultTimeoutMs: 5000,
    });
  });
  it("Action: faults count, no default timeout", () => {
    expect(INVOCATION_POLICY.automationAction.faultsCountTowardQuarantine).toBe(true);
    expect(INVOCATION_POLICY.automationAction.defaultTimeoutMs).toBe(0);
  });
  it("Channel: faults do NOT count", () => {
    expect(INVOCATION_POLICY.notificationChannel.faultsCountTowardQuarantine).toBe(false);
  });
  it("pre Interceptor: faults count, no timeout (synchronous)", () => {
    expect(INVOCATION_POLICY.preInterceptor.faultsCountTowardQuarantine).toBe(true);
    expect(INVOCATION_POLICY.preInterceptor.defaultTimeoutMs).toBe(0);
  });
  it("post Interceptor: faults do NOT count", () => {
    expect(INVOCATION_POLICY.postInterceptor.faultsCountTowardQuarantine).toBe(false);
  });
  it("contributionKindForStorage maps pre/post to lifecycleInterceptor", () => {
    expect(contributionKindForStorage("preInterceptor")).toBe("lifecycleInterceptor");
    expect(contributionKindForStorage("postInterceptor")).toBe("lifecycleInterceptor");
    expect(contributionKindForStorage("signalDetector")).toBe("signalDetector");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validators — raw malformed JavaScript rejection (including arrays — MAJOR 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("validateDetectorResult", () => {
  it("accepts a valid signal array", () => {
    expect(validateDetectorResult([validSignal, { signalType: "detected", subject: "b" }]).ok).toBe(
      true,
    );
  });
  it("accepts an empty array", () => {
    expect(validateDetectorResult([]).ok).toBe(true);
  });
  it("rejects null", () => {
    expect(validateDetectorResult(null).ok).toBe(false);
  });
  it("rejects non-array ({}, string, number)", () => {
    expect(validateDetectorResult({}).ok).toBe(false);
    expect(validateDetectorResult("signals").ok).toBe(false);
    expect(validateDetectorResult(42).ok).toBe(false);
  });
  it("rejects array with non-object element", () => {
    const r = validateDetectorResult([null]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("signal[0]");
  });
  it("rejects array element that is itself an array", () => {
    expect(validateDetectorResult([[1, 2]]).ok).toBe(false);
  });
  it("rejects signal with wrong signalType", () => {
    expect(validateDetectorResult([{ signalType: "user", subject: "x" }]).ok).toBe(false);
  });
  it("rejects signal missing subject", () => {
    expect(validateDetectorResult([{ signalType: "detected" }]).ok).toBe(false);
  });
  it("rejects signal with empty-string subject", () => {
    expect(validateDetectorResult([{ signalType: "detected", subject: "" }]).ok).toBe(false);
  });
  it("rejects signal with non-string body", () => {
    expect(validateDetectorResult([{ signalType: "detected", subject: "x", body: 123 }]).ok).toBe(
      false,
    );
  });
  it("rejects signal with non-object metadata", () => {
    expect(
      validateDetectorResult([{ signalType: "detected", subject: "x", metadata: "nope" }]).ok,
    ).toBe(false);
  });
  it("rejects signal with array metadata (LOW 9)", () => {
    expect(
      validateDetectorResult([{ signalType: "detected", subject: "x", metadata: [] }]).ok,
    ).toBe(false);
  });
  it("strips unknown fields from validated signals", () => {
    const r = validateDetectorResult([{ signalType: "detected", subject: "x", evil: "stripped" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value[0] as unknown as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe("validateActionResult", () => {
  it("accepts succeeded with result", () => {
    const r = validateActionResult({ status: "succeeded", result: { ok: true } });
    expect(r.ok).toBe(true);
  });
  it("accepts failed with error", () => {
    expect(validateActionResult({ status: "failed", error: "boom" }).ok).toBe(true);
  });
  it("rejects null", () => {
    expect(validateActionResult(null).ok).toBe(false);
  });
  it("rejects {}", () => {
    expect(validateActionResult({}).ok).toBe(false);
  });
  it("rejects array (MAJOR 2)", () => {
    expect(validateActionResult([{ status: "succeeded" }]).ok).toBe(false);
  });
  it("rejects invalid status discriminator", () => {
    expect(validateActionResult({ status: "pending" }).ok).toBe(false);
  });
  it("rejects succeeded with non-object result", () => {
    expect(validateActionResult({ status: "succeeded", result: "nope" }).ok).toBe(false);
  });
  it("rejects failed with non-string error", () => {
    expect(validateActionResult({ status: "failed", error: 42 }).ok).toBe(false);
  });
  it("REJECTS succeeded+error (MAJOR 3)", () => {
    const r = validateActionResult({ status: "succeeded", error: "should not be here" });
    expect(r.ok).toBe(false);
  });
  it("REJECTS failed+result (MAJOR 3)", () => {
    const r = validateActionResult({ status: "failed", result: { x: 1 } });
    expect(r.ok).toBe(false);
  });
});

describe("validateChannelResult", () => {
  it("accepts success true", () => {
    expect(validateChannelResult({ success: true }).ok).toBe(true);
  });
  it("accepts success false with error", () => {
    expect(validateChannelResult({ success: false, error: "timeout" }).ok).toBe(true);
  });
  it("rejects null", () => {
    expect(validateChannelResult(null).ok).toBe(false);
  });
  it("rejects array (MAJOR 2)", () => {
    expect(validateChannelResult([true]).ok).toBe(false);
  });
  it("rejects missing success discriminator", () => {
    expect(validateChannelResult({}).ok).toBe(false);
  });
  it("rejects non-boolean success", () => {
    expect(validateChannelResult({ success: "true" }).ok).toBe(false);
  });
  it("rejects non-string error", () => {
    expect(validateChannelResult({ success: false, error: 42 }).ok).toBe(false);
  });
  it("rejects non-number statusCode", () => {
    expect(validateChannelResult({ success: true, statusCode: "500" }).ok).toBe(false);
  });
});

describe("validatePreResult", () => {
  it("accepts allow true", () => {
    expect(validatePreResult({ allow: true }).ok).toBe(true);
  });
  it("accepts allow false with non-empty reason", () => {
    const r = validatePreResult({ allow: false, reason: "blocked", details: "more" });
    expect(r.ok).toBe(true);
  });
  it("rejects null", () => {
    expect(validatePreResult(null).ok).toBe(false);
  });
  it("rejects array (MAJOR 2)", () => {
    expect(validatePreResult([{ allow: true }]).ok).toBe(false);
  });
  it("rejects {}", () => {
    expect(validatePreResult({}).ok).toBe(false);
  });
  it("rejects allow false without reason", () => {
    expect(validatePreResult({ allow: false }).ok).toBe(false);
  });
  it("rejects allow false with empty-string reason", () => {
    expect(validatePreResult({ allow: false, reason: "" }).ok).toBe(false);
  });
  it("rejects non-boolean allow", () => {
    expect(validatePreResult({ allow: "true" }).ok).toBe(false);
  });
});

describe("validatePostResult", () => {
  it("accepts object with no signals key", () => {
    expect(validatePostResult({}).ok).toBe(true);
  });
  it("accepts object with valid signals array", () => {
    expect(validatePostResult({ signals: [validSignal] }).ok).toBe(true);
  });
  it("accepts empty signals array", () => {
    expect(validatePostResult({ signals: [] }).ok).toBe(true);
  });
  it("rejects null", () => {
    expect(validatePostResult(null).ok).toBe(false);
  });
  it("rejects array (MAJOR 2)", () => {
    expect(validatePostResult([{ signals: [] }]).ok).toBe(false);
  });
  it("rejects non-array signals", () => {
    expect(validatePostResult({ signals: "not array" }).ok).toBe(false);
  });
  it("rejects array with invalid signal", () => {
    expect(validatePostResult({ signals: [{ signalType: "user" }] }).ok).toBe(false);
  });
  it("rejects signal with array metadata (LOW 9)", () => {
    expect(
      validatePostResult({
        signals: [{ signalType: "detected", subject: "x", metadata: [] }],
      }).ok,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkPreVeto — synchronous bounded fail-closed
// ─────────────────────────────────────────────────────────────────────────────

describe("checkPreVeto", () => {
  it("returns allow when handler returns { allow: true }", () => {
    const { runtime, deps } = makeRuntime();
    const d = runtime.checkPreVeto(preReq(() => ({ allow: true })));
    expect(d.decision).toBe("allow");
    expect(deps.incrementError).not.toHaveBeenCalled();
  });

  it("returns explicit veto when handler returns { allow: false, reason }", () => {
    const { runtime, deps } = makeRuntime();
    const d = runtime.checkPreVeto(
      preReq(() => ({ allow: false, reason: "policy", details: "x" })),
    );
    expect(d.decision).toBe("veto");
    if (d.decision === "veto") expect(d.vetoReason).toBe("explicit");
    expect(deps.incrementError).not.toHaveBeenCalled();
  });

  it("returns failure veto when handler throws", () => {
    const { runtime, deps } = makeRuntime({ incrementError: vi.fn() });
    const d = runtime.checkPreVeto(
      preReq(() => {
        throw new Error("boom");
      }),
    );
    expect(d.decision).toBe("veto");
    if (d.decision === "veto") expect(d.vetoReason).toBe("failure");
    expect(deps.incrementError).toHaveBeenCalledTimes(1);
  });

  it("returns failure veto when handler returns a Promise", () => {
    const { runtime, deps } = makeRuntime({ incrementError: vi.fn() });
    const d = runtime.checkPreVeto(preReq(() => Promise.resolve({ allow: true })));
    expect(d.decision).toBe("veto");
    if (d.decision === "veto") {
      expect(d.vetoReason).toBe("failure");
      expect(d.message).toContain("Promise");
    }
    expect(deps.incrementError).toHaveBeenCalledTimes(1);
  });

  it("consumes the rejected Promise (MAJOR 1 — no unhandledRejection)", async () => {
    const rejections: unknown[] = [];
    const handler = vi.fn(() => Promise.reject(new Error("async-boom")));
    const { runtime } = makeRuntime({ incrementError: vi.fn() });
    const origHandler = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", (r) => {
      rejections.push(r);
    });
    runtime.checkPreVeto(preReq(handler));
    await new Promise((r) => setTimeout(r, 50));
    process.removeAllListeners("unhandledRejection");
    origHandler.forEach((h) => process.on("unhandledRejection", h));
    expect(rejections).toHaveLength(0);
  });

  it("returns failure veto when handler returns invalid result", () => {
    const { runtime, deps } = makeRuntime({ incrementError: vi.fn() });
    const d = runtime.checkPreVeto(preReq(() => ({ allow: "yes" })));
    expect(d.decision).toBe("veto");
    if (d.decision === "veto") expect(d.vetoReason).toBe("failure");
    expect(deps.incrementError).toHaveBeenCalledTimes(1);
  });

  it("returns failure veto when handler returns null", () => {
    const { runtime, deps } = makeRuntime({ incrementError: vi.fn() });
    const d = runtime.checkPreVeto(preReq(() => null));
    expect(d.decision).toBe("veto");
    expect(deps.incrementError).toHaveBeenCalledTimes(1);
  });

  it("returns allow (skip) when contribution is quarantined", () => {
    const { runtime, deps } = makeRuntime({
      isQuarantined: (key) => key === preTarget.canonicalKey,
      incrementError: vi.fn(),
    });
    const d = runtime.checkPreVeto(preReq(() => ({ allow: false, reason: "x" })));
    expect(d.decision).toBe("allow");
    expect(deps.incrementError).not.toHaveBeenCalled();
  });

  it("returns failure veto with startFailed when startRun throws", () => {
    const { runtime, deps } = makeRuntime({
      startRun: () => {
        throw new Error("DB down");
      },
      incrementError: vi.fn(),
    });
    const d = runtime.checkPreVeto(preReq(() => ({ allow: true })));
    expect(d.decision).toBe("veto");
    if (d.decision === "veto") expect(d.vetoReason).toBe("failure");
    expect(d.startFailed).toBe(true);
    expect(d.runId).toBeNull();
    expect(deps.incrementError).not.toHaveBeenCalled();
  });

  it("buildContext failure = infrastructure failure, no handler, no counter (MEDIUM 6)", () => {
    const inc = vi.fn();
    const handler = vi.fn(() => ({ allow: true }));
    const { runtime, deps } = makeRuntime({
      buildContext: () => {
        throw new Error("context build failed");
      },
      incrementError: inc,
    });
    const d = runtime.checkPreVeto(preReq(handler));
    expect(d.decision).toBe("veto");
    if (d.decision === "veto") expect(d.vetoReason).toBe("failure");
    expect(d.startFailed).toBe(false);
    expect(d.runId).not.toBeNull();
    expect(inc).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    // Pre-interceptors have no catch-up recovery; finish "failed" (not "skipped"
    // like the async Detector path).
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "failed",
      undefined,
      expect.any(String),
    );
  });

  it("preserves decision with finishFailed when finishRun throws", () => {
    const { runtime } = makeRuntime({
      finishRun: () => {
        throw new Error("DB down");
      },
    });
    const d = runtime.checkPreVeto(preReq(() => ({ allow: true })));
    expect(d.decision).toBe("allow");
    expect(d.finishFailed).toBe(true);
  });

  it("preserves explicit veto even if finishRun throws", () => {
    const { runtime } = makeRuntime({
      finishRun: () => {
        throw new Error("DB down");
      },
    });
    const d = runtime.checkPreVeto(preReq(() => ({ allow: false, reason: "blocked" })));
    expect(d.decision).toBe("veto");
    if (d.decision === "veto") expect(d.vetoReason).toBe("explicit");
    expect(d.finishFailed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invokeManaged — Detector
// ─────────────────────────────────────────────────────────────────────────────

describe("invokeManaged — Detector", () => {
  it("returns succeeded with validated signals on success", async () => {
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime();
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.kind).toBe("signalDetector");
    expect(o.status).toBe("succeeded");
    if (o.kind === "signalDetector") {
      expect(o.signals).toHaveLength(1);
      expect(o.signalsEmitted).toBe(1);
    }
  });

  it("increments counter when handler THROWS (not overwritten by helper — MAJOR 4)", async () => {
    const inc = vi.fn();
    detectorTarget.handler = vi.fn(() =>
      Promise.reject(new Error("boom")),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.status).toBe("failed");
    expect(inc).toHaveBeenCalledWith(detectorTarget.canonicalKey, detectorTarget.pluginId);
  });

  it("increments counter when handler returns invalid result", async () => {
    const inc = vi.fn();
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve({ not: "array" }),
    ) as unknown as DetectorTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    await runtime.invokeManaged(detectorReq());
    expect(inc).toHaveBeenCalledTimes(1);
  });

  it("writes skipped when quarantined (no handler invocation)", async () => {
    const handler = vi.fn(() => Promise.resolve([validSignal]));
    detectorTarget.handler = handler as DetectorTarget["handler"];
    const { runtime } = makeRuntime({ isQuarantined: (k) => k === detectorTarget.canonicalKey });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.status).toBe("skipped");
    expect(handler).not.toHaveBeenCalled();
  });

  it("writes rate_limited when detector capacity is denied", async () => {
    const handler = vi.fn(() => Promise.resolve([validSignal]));
    detectorTarget.handler = handler as DetectorTarget["handler"];
    const { runtime } = makeRuntime({ acquireDetectorSlot: () => false });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.status).toBe("rate_limited");
    expect(handler).not.toHaveBeenCalled();
  });

  it("releases detector slot after handler settles (Q12)", async () => {
    const release = vi.fn();
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({ releaseDetectorSlot: release });
    await runtime.invokeManaged(detectorReq());
    expect(release).toHaveBeenCalledWith("hab-1");
  });

  it("does not increment on valid empty array (expected success)", async () => {
    const inc = vi.fn();
    detectorTarget.handler = vi.fn(() => Promise.resolve([])) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    await runtime.invokeManaged(detectorReq());
    expect(inc).not.toHaveBeenCalled();
  });

  it("consumes rejected handlerPromise (BLOCKER 3 — no unhandledRejection)", async () => {
    const rejections: unknown[] = [];
    detectorTarget.handler = vi.fn(() =>
      Promise.reject(new Error("async-boom")),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: vi.fn() });
    const origHandler = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", (r) => {
      rejections.push(r);
    });
    await runtime.invokeManaged(detectorReq());
    await new Promise((r) => setTimeout(r, 50));
    process.removeAllListeners("unhandledRejection");
    origHandler.forEach((h) => process.on("unhandledRejection", h));
    expect(rejections).toHaveLength(0);
  });

  it("onResult hook runs after validation, before finishRun (BLOCKER 1)", async () => {
    const persistedSignals: DetectedSignalInput[][] = [];
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal, { signalType: "detected", subject: "b" }]),
    ) as DetectorTarget["handler"];
    const onResult = vi.fn(async (signals: DetectedSignalInput[]) => {
      persistedSignals.push(signals);
      return signals.length;
    });
    const { runtime, deps } = makeRuntime();
    const o = await runtime.invokeManaged(detectorReq({ onResult }));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(persistedSignals[0]).toHaveLength(2);
    expect(o.status).toBe("succeeded");
    if (o.kind === "signalDetector") expect(o.signalsEmitted).toBe(2);
    // finishRun received the onResult count, not the raw handler array length
    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "succeeded", 2, undefined);
  });

  it("onResult failure finishes run failed without incrementing counter (BLOCKER 1)", async () => {
    const inc = vi.fn();
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
    const onResult = vi.fn(async () => {
      throw new Error("DB write failed");
    });
    const { runtime } = makeRuntime({ incrementError: inc });
    const o = await runtime.invokeManaged(detectorReq({ onResult }));
    expect(o.status).toBe("failed");
    expect(inc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invokeManaged — Action
// ─────────────────────────────────────────────────────────────────────────────

describe("invokeManaged — Action", () => {
  it("returns succeeded on { status: 'succeeded' }", async () => {
    actionTarget.handler = vi.fn(() =>
      Promise.resolve({ status: "succeeded", result: { x: 1 } }),
    ) as ActionTarget["handler"];
    const { runtime } = makeRuntime();
    const o = await runtime.invokeManaged(actionReq());
    expect(o.status).toBe("succeeded");
  });

  it("returns failed but does NOT increment on { status: 'failed' } (domain failure)", async () => {
    const inc = vi.fn();
    actionTarget.handler = vi.fn(() =>
      Promise.resolve({ status: "failed", error: "domain" }),
    ) as ActionTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    const o = await runtime.invokeManaged(actionReq());
    expect(o.status).toBe("failed");
    expect(inc).not.toHaveBeenCalled();
  });

  it("increments counter on throw", async () => {
    const inc = vi.fn();
    actionTarget.handler = vi.fn(() =>
      Promise.reject(new Error("boom")),
    ) as ActionTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    await runtime.invokeManaged(actionReq());
    expect(inc).toHaveBeenCalledTimes(1);
  });

  it("increments counter on invalid result", async () => {
    const inc = vi.fn();
    actionTarget.handler = vi.fn(() =>
      Promise.resolve({ status: "pending" }),
    ) as ActionTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    await runtime.invokeManaged(actionReq());
    expect(inc).toHaveBeenCalledTimes(1);
  });

  it("writes skipped when quarantined", async () => {
    actionTarget.handler = vi.fn(() =>
      Promise.resolve({ status: "succeeded" }),
    ) as ActionTarget["handler"];
    const { runtime } = makeRuntime({ isQuarantined: (k) => k === actionTarget.canonicalKey });
    const o = await runtime.invokeManaged(actionReq());
    expect(o.status).toBe("skipped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invokeManaged — Channel (faults do NOT count)
// ─────────────────────────────────────────────────────────────────────────────

describe("invokeManaged — Channel", () => {
  it("returns succeeded on { success: true }", async () => {
    channelTarget.handler = vi.fn(() =>
      Promise.resolve({ success: true }),
    ) as ChannelTarget["handler"];
    const { runtime } = makeRuntime();
    const o = await runtime.invokeManaged(channelReq());
    expect(o.status).toBe("succeeded");
  });

  it("returns failed but does NOT increment on { success: false } (domain failure)", async () => {
    const inc = vi.fn();
    channelTarget.handler = vi.fn(() =>
      Promise.resolve({ success: false, error: "rejected" }),
    ) as ChannelTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    const o = await runtime.invokeManaged(channelReq());
    expect(o.status).toBe("failed");
    expect(inc).not.toHaveBeenCalled();
  });

  it("does NOT increment counter on throw (non-accounted)", async () => {
    const inc = vi.fn();
    channelTarget.handler = vi.fn(() =>
      Promise.reject(new Error("boom")),
    ) as ChannelTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    await runtime.invokeManaged(channelReq());
    expect(inc).not.toHaveBeenCalled();
  });

  it("does NOT increment counter on invalid result (non-accounted)", async () => {
    const inc = vi.fn();
    channelTarget.handler = vi.fn(() =>
      Promise.resolve({ success: "not-bool" }),
    ) as unknown as ChannelTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    await runtime.invokeManaged(channelReq());
    expect(inc).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invokeManaged — post Interceptor (faults do NOT count)
// ─────────────────────────────────────────────────────────────────────────────

describe("invokeManaged — post Interceptor", () => {
  it("returns succeeded with signals on valid result", async () => {
    postTarget.handler = vi.fn(() => ({
      signals: [validSignal],
    })) as PostInterceptorTarget["handler"];
    const { runtime } = makeRuntime();
    const o = await runtime.invokeManaged(postReq());
    expect(o.status).toBe("succeeded");
    if (o.kind === "postInterceptor") expect(o.signalsEmitted).toBe(1);
  });

  it("does NOT increment counter on throw (non-accounted)", async () => {
    const inc = vi.fn();
    postTarget.handler = vi.fn(() => {
      throw new Error("boom");
    }) as PostInterceptorTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    await runtime.invokeManaged(postReq());
    expect(inc).not.toHaveBeenCalled();
  });

  it("does NOT increment counter on invalid result", async () => {
    const inc = vi.fn();
    postTarget.handler = vi.fn(() => "not-object") as PostInterceptorTarget["handler"];
    const { runtime } = makeRuntime({ incrementError: inc });
    await runtime.invokeManaged(postReq());
    expect(inc).not.toHaveBeenCalled();
  });

  it("onResult hook runs before finishRun (BLOCKER 1)", async () => {
    const onResult = vi.fn(async (signals: DetectedSignalInput[]) => signals.length);
    postTarget.handler = vi.fn(() => ({
      signals: [validSignal],
    })) as PostInterceptorTarget["handler"];
    const { runtime, deps } = makeRuntime();
    await runtime.invokeManaged(postReq({ onResult }));
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "succeeded", 1, undefined);
  });

  it("onResult failure finishes run failed (BLOCKER 1)", async () => {
    const onResult = vi.fn(async () => {
      throw new Error("batch tx failed");
    });
    postTarget.handler = vi.fn(() => ({
      signals: [validSignal],
    })) as PostInterceptorTarget["handler"];
    const { runtime } = makeRuntime();
    const o = await runtime.invokeManaged(postReq({ onResult }));
    expect(o.status).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start / finish failure contract (Q13) + BLOCKER 2 + MAJOR 6
// ─────────────────────────────────────────────────────────────────────────────

describe("start/finish failure contract", () => {
  it("startRun failure: no handler, startFailed=true, no counter increment", async () => {
    const inc = vi.fn();
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
    const { runtime, deps } = makeRuntime({
      startRun: () => {
        throw new Error("DB down");
      },
      incrementError: inc,
    });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.startFailed).toBe(true);
    expect(o.runId).toBeNull();
    expect(inc).not.toHaveBeenCalled();
    expect(detectorTarget.handler).not.toHaveBeenCalled();
    expect(deps.finishRun).not.toHaveBeenCalled();
  });

  it("finishRun failure: handler outcome preserved, finishFailed=true", async () => {
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({
      finishRun: () => {
        throw new Error("DB down");
      },
    });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.startFailed).toBe(false);
    expect(o.finishFailed).toBe(true);
    expect(o.status).toBe("succeeded");
    if (o.kind === "signalDetector") expect(o.signals).toHaveLength(1);
  });

  it("start and finish failures are distinguishable (startFailed vs finishFailed)", async () => {
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
    const o1 = await makeRuntime({
      startRun: () => {
        throw new Error("x");
      },
    }).runtime.invokeManaged(detectorReq());
    expect(o1.startFailed).toBe(true);
    expect(o1.finishFailed).toBe(false);
    const o2 = await makeRuntime({
      finishRun: () => {
        throw new Error("x");
      },
    }).runtime.invokeManaged(detectorReq());
    expect(o2.startFailed).toBe(false);
    expect(o2.finishFailed).toBe(true);
  });

  it("finishRun returning null treated as failure (MAJOR 6)", async () => {
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({ finishRun: vi.fn(() => null) });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.finishFailed).toBe(true);
  });

  it("buildContext failure = infrastructure failure, no handler, no counter (BLOCKER 2)", async () => {
    const inc = vi.fn();
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
    const { runtime, deps } = makeRuntime({
      buildContext: () => {
        throw new Error("context build failed");
      },
      incrementError: inc,
    });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.status).toBe("failed");
    expect(o.startFailed).toBe(false);
    expect(o.handlerLaunched).toBe(false);
    expect(inc).not.toHaveBeenCalled();
    expect(detectorTarget.handler).not.toHaveBeenCalled();
    // BLOCKER 2: DB status is "skipped" (NOT "failed") so the row is
    // recovery-eligible for existsForTriggerEvent on the next catch-up scan.
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "skipped",
      undefined,
      expect.any(String),
    );
  });

  it("buildContext failure releases detector slot (HIGH 3)", async () => {
    const release = vi.fn();
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({
      buildContext: () => {
        throw new Error("ctx fail");
      },
      releaseDetectorSlot: release,
    });
    await runtime.invokeManaged(detectorReq());
    // HIGH 3: slot was acquired in step 3, then buildContext failed in step 4a.
    // The slot MUST be released because no handler Promise will ever exist
    // to attach settlement-based cleanup to.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("pre-veto start failure: failure veto, startFailed=true, no handler, no increment", () => {
    const inc = vi.fn();
    const { runtime } = makeRuntime({
      startRun: () => {
        throw new Error("DB down");
      },
      incrementError: inc,
    });
    const d = runtime.checkPreVeto(preReq(() => ({ allow: true })));
    expect(d.startFailed).toBe(true);
    expect(d.runId).toBeNull();
    expect(inc).not.toHaveBeenCalled();
  });

  it("pre-veto finish failure: preserves handler outcome, finishFailed=true", () => {
    const { runtime } = makeRuntime({
      finishRun: () => {
        throw new Error("DB down");
      },
    });
    const d = runtime.checkPreVeto(preReq(() => ({ allow: true })));
    expect(d.decision).toBe("allow");
    expect(d.finishFailed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — Detector recovery and capacity cleanup (BLOCKER 2 + HIGH 3)
// ─────────────────────────────────────────────────────────────────────────────

describe("R2: handlerLaunched classification (BLOCKER 2)", () => {
  beforeEach(() => {
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
  });

  it("startRun failure: handlerLaunched=false", async () => {
    const { runtime } = makeRuntime({
      startRun: () => {
        throw new Error("DB down");
      },
    });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.handlerLaunched).toBe(false);
  });

  it("quarantine: handlerLaunched=false", async () => {
    const { runtime } = makeRuntime({ isQuarantined: () => true });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.handlerLaunched).toBe(false);
  });

  it("rate_limited: handlerLaunched=false", async () => {
    const { runtime } = makeRuntime({ acquireDetectorSlot: () => false });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.handlerLaunched).toBe(false);
  });

  it("context failure: handlerLaunched=false", async () => {
    const { runtime } = makeRuntime({
      buildContext: () => {
        throw new Error("ctx fail");
      },
    });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.handlerLaunched).toBe(false);
  });

  it("validation failure: handlerLaunched=true", async () => {
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve("not-an-array" as unknown),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime();
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.handlerLaunched).toBe(true);
  });

  it("async rejection: handlerLaunched=true", async () => {
    detectorTarget.handler = vi.fn(() =>
      Promise.reject(new Error("async boom")),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime();
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.handlerLaunched).toBe(true);
  });

  it("success: handlerLaunched=true", async () => {
    const { runtime } = makeRuntime();
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.handlerLaunched).toBe(true);
  });
});

describe("R2: pre-launch finish failure → deleteRun fallback (BLOCKER 2)", () => {
  beforeEach(() => {
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
  });

  it("quarantine finish failure → deleteRun called (stranded running row)", async () => {
    const del = vi.fn((): boolean => true);
    const { runtime, deps } = makeRuntime({
      isQuarantined: () => true,
      finishRun: () => {
        throw new Error("finishRun DB down");
      },
      deleteRun: del,
    });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.finishFailed).toBe(true);
    expect(del).toHaveBeenCalledWith(expect.any(String));
    expect(deps.deleteRun).toHaveBeenCalledTimes(1);
  });

  it("capacity finish failure → deleteRun called", async () => {
    const del = vi.fn((): boolean => true);
    const { runtime } = makeRuntime({
      acquireDetectorSlot: () => false,
      finishRun: () => {
        throw new Error("finishRun DB down");
      },
      deleteRun: del,
    });
    await runtime.invokeManaged(detectorReq());
    expect(del).toHaveBeenCalledWith(expect.any(String));
  });

  it("context failure finish failure → deleteRun called", async () => {
    const del = vi.fn((): boolean => true);
    const { runtime } = makeRuntime({
      buildContext: () => {
        throw new Error("ctx fail");
      },
      finishRun: () => {
        throw new Error("finishRun DB down");
      },
      deleteRun: del,
    });
    await runtime.invokeManaged(detectorReq());
    expect(del).toHaveBeenCalledWith(expect.any(String));
  });

  it("post-launch finish failure does NOT call deleteRun (Q13 — handler outcome preserved)", async () => {
    const del = vi.fn((): boolean => true);
    detectorTarget.handler = vi.fn(() =>
      Promise.reject(new Error("handler boom")),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({
      finishRun: () => {
        throw new Error("finishRun DB down");
      },
      deleteRun: del,
    });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.handlerLaunched).toBe(true);
    expect(o.finishFailed).toBe(true);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("R2: slot cleanup on every pre-launch path (HIGH 3)", () => {
  beforeEach(() => {
    detectorTarget.handler = vi.fn(() =>
      Promise.resolve([validSignal]),
    ) as DetectorTarget["handler"];
  });

  it("synchronous handler throw releases slot (HIGH 3)", async () => {
    const release = vi.fn();
    detectorTarget.handler = vi.fn(() => {
      throw new Error("sync boom");
    }) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({
      releaseDetectorSlot: release,
    });
    const o = await runtime.invokeManaged(detectorReq());
    // Sync throw: handler was invoked (handlerLaunched=true) but no Promise
    // was returned, so settlement-based cleanup was never attached.
    expect(o.handlerLaunched).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("quarantine does NOT acquire or release slot (before step 3)", async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => true);
    const { runtime } = makeRuntime({
      isQuarantined: () => true,
      acquireDetectorSlot: acquire,
      releaseDetectorSlot: release,
    });
    await runtime.invokeManaged(detectorReq());
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("rate_limited (capacity denied) does NOT release slot (never acquired)", async () => {
    const release = vi.fn();
    const { runtime } = makeRuntime({
      acquireDetectorSlot: () => false,
      releaseDetectorSlot: release,
    });
    await runtime.invokeManaged(detectorReq());
    expect(release).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Watchdog timeout (injected via withTimeout)
// ─────────────────────────────────────────────────────────────────────────────

describe("watchdog timeout", () => {
  it("Detector timeout counts as runtime fault", async () => {
    const inc = vi.fn();
    detectorTarget.handler = vi.fn(() => new Promise(() => {})) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({
      withTimeout: (() =>
        Promise.reject(new Error("timed out"))) as unknown as RuntimeDeps["withTimeout"],
      incrementError: inc,
    });
    const o = await runtime.invokeManaged(detectorReq());
    expect(o.status).toBe("failed");
    expect(inc).toHaveBeenCalledTimes(1);
  });

  it("Channel timeout does NOT count (non-accounted)", async () => {
    const inc = vi.fn();
    channelTarget.handler = vi.fn(() => new Promise(() => {})) as ChannelTarget["handler"];
    const { runtime } = makeRuntime({
      withTimeout: (() =>
        Promise.reject(new Error("timed out"))) as unknown as RuntimeDeps["withTimeout"],
      incrementError: inc,
    });
    await runtime.invokeManaged(channelReq());
    expect(inc).not.toHaveBeenCalled();
  });

  it("Detector timeout releases slot (Q12 — release on underlying settlement)", async () => {
    const release = vi.fn();
    // Underlying handler resolves after a short delay (simulating a slow handler that
    // outlives the watchdog). The slot should release when it settles.
    detectorTarget.handler = vi.fn(
      () => new Promise((r) => setTimeout(() => r([validSignal]), 10)),
    ) as DetectorTarget["handler"];
    const { runtime } = makeRuntime({
      withTimeout: (() =>
        Promise.reject(new Error("timed out"))) as unknown as RuntimeDeps["withTimeout"],
      releaseDetectorSlot: release,
      incrementError: vi.fn(),
    });
    await runtime.invokeManaged(detectorReq());
    // Wait for the underlying handler to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(release).toHaveBeenCalledWith("hab-1");
  });
});
