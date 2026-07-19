/**
 * T9B Phase 3 — `scheduledOccurrenceRepairRoutes` focused tests.
 *
 * Proves the route-layer guarantees (the `POST /scheduled-occurrences/:id/retry`
 * endpoint — DORMANT behind the cutover flag):
 *
 *  (a) REGISTRATION — the route is registered under
 *      `/scheduled-occurrences/:id/retry` (POST) with `humanAuth + adminOnly`.
 *  (b) AUTHORIZATION — the route requires admin (non-admin → 403).
 *  (c) DORMANCY — the route is NOT registered when the cutover flag is off
 *      (a request 404s — true dormancy, not a runtime gate).
 *  (d) HANDLER — the handler maps the closed
 *      `RepairScheduledOccurrenceOutcome` to HTTP (201 on `repaired`, 409
 *      on retry failures, 404 on not-found).
 *
 * Mirrors `scheduledTaskRoutes.test.ts`'s unit-style route-capture pattern
 * (capture the route registration via a fake Fastify + invoke the handler
 * directly with mocked dependencies). The integration assertion (the
 * retry's actual effect on the database) is covered separately in
 * `scheduledOccurrenceRepair.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// --- Mocks: the cutover flag + the repair adapter + the auth middleware ---

const { mockIsCreationPublicationEnabled, mockRepairScheduledOccurrence } = vi.hoisted(() => ({
  mockIsCreationPublicationEnabled: vi.fn<() => boolean>(() => false),
  mockRepairScheduledOccurrence: vi.fn<(input: { occurrenceId: string; actorId: string }) => any>(
    () => ({ outcome: "not_found" }),
  ),
}));

vi.mock("../config/creationPublicationCutover.js", () => ({
  isCreationPublicationEnabled: mockIsCreationPublicationEnabled,
}));

vi.mock("../services/scheduledOccurrenceRepair.js", () => ({
  repairScheduledOccurrence: mockRepairScheduledOccurrence,
}));

// Capture the preHandler chain the route registers. The middleware
// functions are passed through as-is (the test asserts their identity).
const { mockHumanAuth, mockAdminOnly, mockNotFound } = vi.hoisted(() => ({
  mockHumanAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
  mockAdminOnly: vi.fn((_req: any, _reply: any, done: any) => done()),
  mockNotFound: (msg: string, code?: string) => Object.assign(new Error(msg), { code }),
}));

vi.mock("../middleware/auth.js", () => ({
  humanAuth: mockHumanAuth,
}));

vi.mock("../middleware/rbac.js", () => ({
  adminOnly: mockAdminOnly,
}));

vi.mock("../errors.js", () => ({
  notFound: mockNotFound,
}));

// Load AFTER mocks are in place.
import scheduledOccurrenceRepairRoutesModule, {
  scheduledOccurrenceRepairRoutes,
} from "../routes/scheduledOccurrenceRepair.js";

// ---------------------------------------------------------------------------
// Route-capture harness (mirrors scheduledTaskRoutes.test.ts)
// ---------------------------------------------------------------------------

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: unknown[];
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
}

function captureScheduledOccurrenceRepairRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: Pick<FastifyInstance, "post"> = {
    post: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({
        method: "POST",
        path,
        preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [],
        handler,
      });
    }) as any,
  };
  scheduledOccurrenceRepairRoutes(fakeFastify as unknown as FastifyInstance);
  return routes;
}

function resetMocks(): void {
  vi.clearAllMocks();
  mockIsCreationPublicationEnabled.mockReturnValue(true);
  mockRepairScheduledOccurrence.mockReturnValue({ outcome: "not_found" });
}

// ===========================================================================
// 1. REGISTRATION + DORMANCY.
// ===========================================================================

describe("scheduledOccurrenceRepairRoutes — registration + dormancy", () => {
  beforeEach(resetMocks);

  it("exports a function named scheduledOccurrenceRepairRoutes", () => {
    expect(scheduledOccurrenceRepairRoutes).toBeInstanceOf(Function);
    expect(scheduledOccurrenceRepairRoutes.name).toBe("scheduledOccurrenceRepairRoutes");
  });

  it("registers POST /scheduled-occurrences/:id/retry when the cutover flag is ON", () => {
    mockIsCreationPublicationEnabled.mockReturnValue(true);
    const routes = captureScheduledOccurrenceRepairRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
    expect(routes[0].path).toBe("/scheduled-occurrences/:id/retry");
  });

  it("DORMANCY: registers ZERO routes when the cutover flag is OFF (true dormancy — the route 404s in production by default)", () => {
    mockIsCreationPublicationEnabled.mockReturnValue(false);
    const routes = captureScheduledOccurrenceRepairRoutes();
    expect(routes).toHaveLength(0);
  });

  it("registers humanAuth + adminOnly as the preHandler chain (admin-only authorization)", () => {
    mockIsCreationPublicationEnabled.mockReturnValue(true);
    const routes = captureScheduledOccurrenceRepairRoutes();
    expect(routes[0].preHandler).toContain(mockHumanAuth);
    expect(routes[0].preHandler).toContain(mockAdminOnly);
  });
});

// ===========================================================================
// 2. HANDLER — outcome → HTTP mapping.
// ===========================================================================

describe("scheduledOccurrenceRepairRoutes — handler outcome mapping", () => {
  beforeEach(resetMocks);

  it("`repaired` → 201 + the Mission committed", async () => {
    const mission = { id: "m-1", habitatId: "h-1", createdBy: "scheduler" };
    const tasks = [{ task: { id: "t-1" }, event: { taskId: "t-1" }, envelope: { taskId: "t-1" } }];
    mockRepairScheduledOccurrence.mockReturnValue({
      outcome: "repaired",
      retryNumber: 1,
      occurrence: { id: "occ-1", state: "rejected" },
      mission,
      tasks,
      workflow: null,
    });

    const routes = captureScheduledOccurrenceRepairRoutes();
    const reply: any = { code: vi.fn(() => reply), send: vi.fn(() => reply) };
    await routes[0].handler(
      { params: { id: "occ-1" }, user: { id: "admin-1", role: "admin" } },
      reply,
    );
    expect(mockRepairScheduledOccurrence).toHaveBeenCalledWith({
      occurrenceId: "occ-1",
      actorId: "admin-1",
    });
    expect(reply.code).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "repaired",
        retryNumber: 1,
        mission,
        tasks,
      }),
    );
  });

  it("`retry_failed_vetoed` → 409 + the veto details", async () => {
    mockRepairScheduledOccurrence.mockReturnValue({
      outcome: "retry_failed_vetoed",
      retryNumber: 1,
      occurrence: { id: "occ-1", state: "rejected" },
      vetoes: [{ taskIndex: 0, veto: { interceptorKey: "ic-1", reason: "no", pluginRunId: null } }],
    });

    const routes = captureScheduledOccurrenceRepairRoutes();
    const reply: any = { code: vi.fn(() => reply), send: vi.fn(() => reply) };
    await routes[0].handler(
      { params: { id: "occ-1" }, user: { id: "admin-1", role: "admin" } },
      reply,
    );
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "retry_failed_vetoed",
        vetoes: expect.any(Array),
      }),
    );
  });

  it("`retry_failed_validation` → 422 + the errors", async () => {
    mockRepairScheduledOccurrence.mockReturnValue({
      outcome: "retry_failed_validation",
      retryNumber: 1,
      occurrence: { id: "occ-1", state: "rejected" },
      errors: [{ field: "templateId", code: "template_not_set", message: "no template" }],
    });

    const routes = captureScheduledOccurrenceRepairRoutes();
    const reply: any = { code: vi.fn(() => reply), send: vi.fn(() => reply) };
    await routes[0].handler(
      { params: { id: "occ-1" }, user: { id: "admin-1", role: "admin" } },
      reply,
    );
    expect(reply.code).toHaveBeenCalledWith(422);
  });

  it("`retry_failed_schedule_missing` → 409", async () => {
    mockRepairScheduledOccurrence.mockReturnValue({
      outcome: "retry_failed_schedule_missing",
      retryNumber: 1,
      occurrence: { id: "occ-1", state: "rejected" },
    });

    const routes = captureScheduledOccurrenceRepairRoutes();
    const reply: any = { code: vi.fn(() => reply), send: vi.fn(() => reply) };
    await routes[0].handler(
      { params: { id: "occ-1" }, user: { id: "admin-1", role: "admin" } },
      reply,
    );
    expect(reply.code).toHaveBeenCalledWith(409);
  });

  it("`illegal_source_state` → 409", async () => {
    mockRepairScheduledOccurrence.mockReturnValue({
      outcome: "illegal_source_state",
      occurrence: { id: "occ-1", state: "published" },
      fromState: "published",
    });

    const routes = captureScheduledOccurrenceRepairRoutes();
    const reply: any = { code: vi.fn(() => reply), send: vi.fn(() => reply) };
    await routes[0].handler(
      { params: { id: "occ-1" }, user: { id: "admin-1", role: "admin" } },
      reply,
    );
    expect(reply.code).toHaveBeenCalledWith(409);
  });

  it("`not_found` → throws notFound (the global error handler maps to 404)", async () => {
    mockRepairScheduledOccurrence.mockReturnValue({ outcome: "not_found" });

    const routes = captureScheduledOccurrenceRepairRoutes();
    await expect(
      routes[0].handler(
        { params: { id: "missing-occ" }, user: { id: "admin-1", role: "admin" } },
        {},
      ),
    ).rejects.toThrow("Scheduled occurrence not found");
  });

  it("passes the operator's authenticated user.id as the retry's actorId", async () => {
    mockRepairScheduledOccurrence.mockReturnValue({ outcome: "not_found" });

    const routes = captureScheduledOccurrenceRepairRoutes();
    await routes[0]
      .handler({ params: { id: "occ-1" }, user: { id: "specific-admin", role: "admin" } }, {})
      .catch(() => null); // not_found throws; we only care about the call shape.
    expect(mockRepairScheduledOccurrence).toHaveBeenCalledWith({
      occurrenceId: "occ-1",
      actorId: "specific-admin",
    });
  });
});

// ===========================================================================
// 3. Default export (the test-harness convention).
// ===========================================================================

describe("scheduledOccurrenceRepairRoutes — default export", () => {
  it("the default export is the route registration function", () => {
    expect(scheduledOccurrenceRepairRoutesModule).toBe(scheduledOccurrenceRepairRoutes);
  });
});
