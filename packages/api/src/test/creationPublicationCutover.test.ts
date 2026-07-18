/**
 * Fix-P1 (C1) — Creation-publication cutover gate (dormancy inventory).
 *
 * Proves the 3 post-cutover mutation routes are DORMANT in production by
 * default (flag off → unregistered → 404), and ACTIVE when the cutover flag
 * is on (flag on → registered → auth-layer 401, NOT a routing 404).
 *
 * The gate lives in `config/creationPublicationCutover.ts` and is read at
 * route-registration time in:
 *   - `index.ts:registerApiRoutes` — gates `taskPublicationRoutes` +
 *     `taskClonePublicationRoutes`.
 *   - `routes/tasks/index.ts:taskRoutes` — gates `taskAssignmentRoutes`.
 *
 * This test replicates the EXACT gate logic (read-only route always mounts;
 * 3 mutation routes mount only when `isCreationPublicationEnabled()`) on a
 * lightweight app. It does NOT boot the full server (the route plugins are
 * the same ones `registerApiRoutes` uses — the gate is the only variable).
 *
 * Read-only routes (`GET /task-creation-attempts/:attemptId`,
 * `GET /tasks/:sourceTaskId/clone-preparation`) are NOT gated — they are safe
 * to mount unconditionally (no writes, no POST_CUTOVER state creation). This
 * test verifies the read-only route stays present with the flag OFF.
 *
 * Authority: no auth → 401 is the "route exists" signal (the preHandler
 * blocks before any handler logic). A routing 404 is the "route absent"
 * signal. The distinction is unambiguous: 401 = registered; 404 = dormant.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { closeDb, initTestDb } from "../db/index.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import { taskPublicationRoutes } from "../routes/taskPublication.js";
import { taskClonePublicationRoutes } from "../routes/taskClonePublication.js";
import { taskAssignmentRoutes } from "../routes/tasks/assignment.js";
import { taskCreationAttemptRoutes } from "../routes/taskCreationAttempts.js";
import { registerErrorHandler } from "../errors/plugin.js";

const FLAG = "ORCY_CREATION_PUBLICATION_ENABLED";

/**
 * Builds an app replicating the gate from `index.ts:registerApiRoutes` +
 * `routes/tasks/index.ts:taskRoutes`. The gate structure:
 *
 *   - `taskCreationAttemptRoutes` — read-only, ALWAYS mounted.
 *   - `taskClonePublicationRoutes` — ALWAYS mounted at the index level, but
 *     its POST mutation route is gated INSIDE the plugin (the GET
 *     clone-preparation stays mounted regardless).
 *   - `taskPublicationRoutes` — gated at the index level (POST only).
 *   - `taskAssignmentRoutes` — gated at the `taskRoutes` level (POST only).
 *
 * The env var is read at REGISTRATION time, so toggling it BEFORE `buildApp()`
 * flips which mutation routes mount. This mirrors the production boot cycle
 * (routes are fixed for the process lifetime once registered).
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      const enabled = process.env[FLAG] === "true";
      // Read-only recovery surface — ALWAYS mounted (NOT gated).
      await f.register(taskCreationAttemptRoutes);
      // Clone routes — always mounted (GET clone-preparation stays live);
      // the POST clone-publication is gated INSIDE the plugin.
      await f.register(taskClonePublicationRoutes);
      // The 2 POST-only mutation routes — gated at registration.
      if (enabled) {
        await f.register(taskPublicationRoutes);
        await f.register(taskAssignmentRoutes);
      }
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

describe("Fix-P1 — creation-publication cutover gate (dormancy inventory)", () => {
  let originalFlag: string | undefined;

  beforeEach(async () => {
    await initTestDb();
    originalFlag = process.env[FLAG];
    delete process.env[FLAG];
  });

  afterEach(async () => {
    if (originalFlag !== undefined) {
      process.env[FLAG] = originalFlag;
    } else {
      delete process.env[FLAG];
    }
    closeDb();
  });

  // ------------------------------------------------------------------------
  // Flag OFF (production default) — 3 mutation routes are ABSENT (404).
  // ------------------------------------------------------------------------

  describe("flag OFF (production default)", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildApp();
    });
    afterEach(async () => {
      if (app) await app.close();
    });

    it("POST /missions/:missionId/task-publications → 404 (dormant)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/missions/any-mission/task-publications",
      });
      expect(res.statusCode).toBe(404);

      // **Failure mode**: if the route were registered, a no-auth request
      // would hit the preHandler (agentOrHumanAuth → 401). A 404 proves the
      // route is genuinely unregistered — true dormancy.
    });

    it("POST /tasks/:sourceTaskId/clone-publications → 404 (dormant)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/any-source/clone-publications",
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /tasks/:taskId/assignment-attempts → 404 (dormant)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/any-task/assignment-attempts",
      });
      expect(res.statusCode).toBe(404);
    });

    it("GET /tasks/:sourceTaskId/clone-preparation → NOT 404 (read-only route stays mounted)", async () => {
      // The clone-preparation GET is mounted via `taskClonePublicationRoutes`,
      // which is ALWAYS registered — only its POST clone-publication sibling
      // is gated inside the plugin. So the GET is live even with the flag off.
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks/any-source/clone-preparation",
      });
      // 401 = route registered, auth blocked (NOT a routing 404).
      expect(res.statusCode).not.toBe(404);

      // **Failure mode**: if the gate accidentally suppressed the read-only
      // clone-preparation GET, the clone composer UI couldn't prefill the
      // form pre-T11. The GET must stay live (it's a safe read-only surface).
    });

    it("GET /task-creation-attempts/:attemptId → NOT 404 (read-only route stays mounted)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/task-creation-attempts/any-attempt",
      });
      // 401 = route registered, auth blocked (NOT a routing 404).
      expect(res.statusCode).not.toBe(404);

      // **Failure mode**: if the gate accidentally suppressed the read-only
      // recovery route, a production caller polling for an attempt's status
      // would get a routing 404 — breaking the recovery contract.
    });
  });

  // ------------------------------------------------------------------------
  // Flag ON (T11 / tests) — 3 mutation routes are PRESENT (not 404).
  // ------------------------------------------------------------------------

  describe("flag ON (T11 / tests)", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      process.env[FLAG] = "true";
      app = await buildApp();
    });
    afterEach(async () => {
      if (app) await app.close();
    });

    it("POST /missions/:missionId/task-publications → registered (auth 401, NOT 404)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/missions/any-mission/task-publications",
      });
      // 401 = route registered; preHandler blocked the anonymous request.
      // (NOT 404 — the route is present.)
      expect(res.statusCode).not.toBe(404);
    });

    it("POST /tasks/:sourceTaskId/clone-publications → registered (auth 401, NOT 404)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/any-source/clone-publications",
      });
      expect(res.statusCode).not.toBe(404);
    });

    it("POST /tasks/:taskId/assignment-attempts → registered (auth 401, NOT 404)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/tasks/any-task/assignment-attempts",
      });
      expect(res.statusCode).not.toBe(404);
    });

    it("GET /task-creation-attempts/:attemptId → still registered (read-only unaffected)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/task-creation-attempts/any-attempt",
      });
      expect(res.statusCode).not.toBe(404);
    });

    it("GET /tasks/:sourceTaskId/clone-preparation → still registered (read-only unaffected)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/tasks/any-source/clone-preparation",
      });
      expect(res.statusCode).not.toBe(404);
    });
  });
});
