import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AuditActorRef, AuditSource, CausalContext } from "@orcy/shared";
import * as templateRepo from "../repositories/template.js";
import * as missionRepo from "../repositories/mission.js";
import { tasks, workflows, taskCreationEnvelopes } from "../db/schema/index.js";
import { humanAuth, agentOrHumanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
import { z } from "zod";
import { badRequest, notFound, forbidden, unprocessableEntity, conflict } from "../errors.js";
import { getDb } from "../db/index.js";
import { prepareTemplateAggregate } from "../services/templateAggregatePreparation.js";
import { publishTemplateAggregateWithClient } from "../services/templateAggregatePublication.js";
import { reserveAttemptWithClient } from "../repositories/taskCreationAttempts.js";

const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  titlePattern: z.string().min(1).max(200),
  descriptionPattern: z.string().max(5000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  labels: z.array(z.string()).optional(),
  requiredDomain: z.string().nullable().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  tasksTemplate: z.array(z.any()).optional(),
  workflowTemplate: z.any().optional().nullable(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  titlePattern: z.string().min(1).max(200).optional(),
  descriptionPattern: z.string().max(5000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  labels: z.array(z.string()).optional(),
  requiredDomain: z.string().nullable().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  tasksTemplate: z.array(z.any()).optional(),
  workflowTemplate: z.any().optional().nullable(),
});

const applyTemplateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  labels: z.array(z.string()).optional(),
  variables: z.record(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Template application composes the aggregate publication kernel chain
// (`prepareTemplateAggregate` → reserve N attempts →
// `publishTemplateAggregateWithClient`).
// ---------------------------------------------------------------------------

/**
 * Computes the canonical request fingerprint for a route-initiated template
 * application. Covers the rendered payload identity (template + target mission
 * + the override shape) so a same-key retry with the SAME fingerprint REPLAYS;
 * a payload edit under the same key is deterministically rejected. EXCLUDES
 * provenance (actor / source) — those are stamped server-side.
 *
 * Mirrors `taskCreationPublication.computeRequestFingerprint` (stable stringify
 * + sorted keys + SHA-256 hash) so the reservation dedup contract is identical
 * across the route-level publications.
 */
function computeTemplateApplicationFingerprint(input: {
  templateId: string;
  missionId: string;
  overrides: z.infer<typeof applyTemplateSchema>;
}): string {
  const sortedOverrides = {
    title: input.overrides.title ?? "",
    description: input.overrides.description ?? "",
    priority: input.overrides.priority ?? "medium",
    labels: [...(input.overrides.labels ?? [])].sort(),
    variables: sortRecordKeys(input.overrides.variables ?? {}),
  };
  const payload = {
    templateId: input.templateId,
    missionId: input.missionId,
    overrides: sortedOverrides,
  };
  return "route_template:" + stableHash(stableStringify(payload));
}

/** Deterministic JSON serializer — sorted object keys, stable array order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** SHA-256 hex of the canonical stable-string serialization. */
function stableHash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Recursively sorts a string-keyed record for deterministic fingerprinting. */
function sortRecordKeys(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

/**
 * Task template management — create, list, update, delete, and track usage.
 */
export async function templateRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /habitats/:habitatId/templates - List templates for a board. Auth: agentOrHumanAuth. Returns { templates } */
  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/templates",
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, _reply: FastifyReply) => {
      const templates = templateRepo.getTemplatesByHabitatId(request.params.habitatId);
      return { templates };
    },
  );

  /** POST /habitats/:habitatId/templates - Create a template. Auth: humanAuth. Returns { template } */
  fastify.post<{ Params: { habitatId: string }; Body: z.infer<typeof createTemplateSchema> }>(
    "/habitats/:habitatId/templates",
    { preHandler: humanAuth },
    async (
      request: FastifyRequest<{
        Params: { habitatId: string };
        Body: z.infer<typeof createTemplateSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const parsed = createTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const userId = request.user?.id ?? "anonymous";

      const template = templateRepo.createTemplate({
        habitatId: request.params.habitatId,
        name: parsed.data.name,
        titlePattern: parsed.data.titlePattern,
        descriptionPattern: parsed.data.descriptionPattern,
        priority: parsed.data.priority,
        labels: parsed.data.labels,
        requiredDomain: parsed.data.requiredDomain,
        requiredCapabilities: parsed.data.requiredCapabilities,
        tasksTemplate: parsed.data.tasksTemplate,
        workflowTemplate: parsed.data.workflowTemplate,
        createdBy: userId,
      });

      reply.code(201).send({ template });
    },
  );

  /** PATCH /templates/:id - Update a template. Auth: humanAuth. Returns { template } or 404 */
  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateTemplateSchema> }>(
    "/templates/:id",
    { preHandler: humanAuth },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: z.infer<typeof updateTemplateSchema>;
      }>,
      _reply: FastifyReply,
    ) => {
      const parsed = updateTemplateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const template = templateRepo.updateTemplate(request.params.id, {
        name: parsed.data.name,
        titlePattern: parsed.data.titlePattern,
        descriptionPattern: parsed.data.descriptionPattern,
        priority: parsed.data.priority,
        labels: parsed.data.labels,
        requiredDomain: parsed.data.requiredDomain,
        requiredCapabilities: parsed.data.requiredCapabilities,
        tasksTemplate: parsed.data.tasksTemplate,
        workflowTemplate: parsed.data.workflowTemplate,
      });

      if (!template) {
        throw notFound("Template not found");
      }

      return { template };
    },
  );

  /** DELETE /templates/:id - Delete a template. Auth: humanAuth + adminOnly. Returns 204 or 404/403 */
  fastify.delete<{ Params: { id: string } }>(
    "/templates/:id",
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const template = templateRepo.getTemplateById(request.params.id);
      if (!template) {
        throw notFound("Template not found");
      }

      if (template.isDefault) {
        throw forbidden("Cannot delete default template");
      }

      const deleted = templateRepo.deleteTemplate(request.params.id);
      if (!deleted) {
        throw notFound("Template not found");
      }

      reply.code(204).send();
    },
  );

  /** POST /templates/:id/usage - Increment template usage count. Auth: agentOrHumanAuth. Returns { success: true } */
  fastify.post<{ Params: { id: string } }>(
    "/templates/:id/usage",
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const template = templateRepo.getTemplateById(request.params.id);
      if (!template) {
        throw notFound("Template not found");
      }

      templateRepo.incrementUsageCount(request.params.id);
      return { success: true };
    },
  );

  /** POST /missions/:missionId/apply-template/:templateId - Apply template to create feature+tasks. Auth: humanAuth. Returns { feature, tasks } */
  fastify.post<{
    Params: { missionId: string; templateId: string };
    Body: z.infer<typeof applyTemplateSchema>;
  }>(
    "/missions/:missionId/apply-template/:templateId",
    { preHandler: humanAuth },
    async (
      request: FastifyRequest<{
        Params: { missionId: string; templateId: string };
        Body: z.infer<typeof applyTemplateSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const parsed = applyTemplateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const existingMission = missionRepo.getMissionById(request.params.missionId);
      if (!existingMission) {
        throw notFound("Mission not found");
      }

      const template = templateRepo.getTemplateById(request.params.templateId);
      if (!template) {
        throw notFound("Template not found");
      }

      if (template.habitatId !== null && template.habitatId !== existingMission.habitatId) {
        throw forbidden("Template does not belong to this habitat");
      }

      // The middleware guarantees `request.user?.id`; defensive fallback
      // mirrors the taskPublication route's guard (`routes/taskPublication.ts:163-166`).
      const actorId = request.user?.id;
      if (!actorId) {
        throw forbidden("Authentication required", "INSUFFICIENT_PERMISSIONS");
      }

      // Server-constructed provenance — untrusted body fields cannot assert
      // privileged identities. The `auditSource` enum is the ORIGIN CHANNEL
      // (REST API = `"rest_api"`); the human-vs-API surface lives in the
      // causal-root.type (`"human"` for human via rest_api — matches
      // `services/taskCreationPublication.ts:304-308`).
      const actor: AuditActorRef = { type: "human", id: actorId };
      const auditSource: AuditSource = "rest_api";
      const causalContext: CausalContext = {
        root: { type: "human", id: actorId },
      };

      // 1. PREPARE (PURE validation + canonicalization)
      const prepared = prepareTemplateAggregate(
        request.params.templateId,
        existingMission.habitatId,
        parsed.data,
        { actor, auditSource, causalContext },
      );

      if (prepared.outcome === "rejected_validation") {
        throw unprocessableEntity(
          "Template preparation rejected",
          "TEMPLATE_PREPARATION_REJECTED",
          { errors: prepared.errors },
        );
      }

      const aggregate = prepared.aggregate;

      // 2. RESERVE N attempts (one per prepared Task). The attemptKey is
      //    DERIVED from `(templateId, taskIndex, requestFingerprint)` so it
      //    is STABLE across retries of the SAME request — a response-loss
      //    retry hits the same reservation key and replays (no duplicate
      //    Mission/Task). A DIFFERENT overrides set produces a different
      //    fingerprint → a different key → a fresh publication (a legitimate
      //    distinct application). Mirrors the deterministic key derivation
      //    in the triage adapter (`triageMissionPublication.ts:780`) and
      //    the scheduled-occurrence path (which derives its attempt identity
      //    from the occurrence + schedule).
      const db = getDb();
      const requestFingerprint = computeTemplateApplicationFingerprint({
        templateId: request.params.templateId,
        missionId: request.params.missionId,
        overrides: parsed.data,
      });

      const attemptIds: string[] = [];
      const replayAttemptIds: string[] = [];
      for (let i = 0; i < aggregate.tasks.length; i++) {
        const attemptKey = `${request.params.templateId}-${i}-${requestFingerprint}`;
        const reservation = reserveAttemptWithClient(db, {
          source: auditSource,
          sourceScopeKind: "mission",
          sourceScopeId: request.params.missionId,
          attemptKey,
          requestFingerprint,
          publicationKind: "create",
          habitatId: existingMission.habitatId,
          actorType: "human",
          actorId,
          causalContext,
        });

        // With deterministic keys embedding the fingerprint, a
        // `rejected_fingerprint` is a hash-collision anomaly
        // (astronomically unlikely with SHA-256). Surface as an internal
        // error so the operator notices rather than masking it.
        if (reservation.outcome === "rejected_fingerprint") {
          throw new Error(
            `templates route: deterministic attempt reservation rejected on fingerprint (templateId="${request.params.templateId}", missionId="${request.params.missionId}", taskIndex=${i})`,
          );
        }

        const attempt = reservation.attempt;

        if (attempt.state === "pending") {
          // Fresh or pending-resume → collect for publication.
          attemptIds.push(attempt.id);
        } else {
          // Non-pending: the aggregate already committed under this key
          // set (response-loss retry). The kernel's per-Task checkpoint
          // protocol forbids re-publishing a non-pending attempt, so
          // collect the attemptId for envelope-based reconstruction
          // instead of re-publishing.
          replayAttemptIds.push(attempt.id);
        }
      }

      // 2a. REPLAY — the aggregate already committed (response-loss retry).
      //     Reconstruct the published result from the durable
      //     `task_creation_envelopes` rows (keyed by `attemptId`) — the
      //     same pattern as the blocker adapter's
      //     `readCommittedBlockerPublication`. Return 200 (the resource
      //     already existed). The kernel's replay/fingerprint mechanism
      //     ensures a same-key retry returns `replayed` (no duplicate
      //     Mission/Task).
      if (replayAttemptIds.length > 0) {
        const replayedTasks = replayAttemptIds
          .map((id) => {
            const envelope = db
              .select()
              .from(taskCreationEnvelopes)
              .where(eq(taskCreationEnvelopes.attemptId, id))
              .get();
            if (!envelope) return undefined;
            return db.select().from(tasks).where(eq(tasks.id, envelope.taskId)).get();
          })
          .filter((t): t is typeof tasks.$inferSelect => t !== undefined);
        const replayMissionId = replayedTasks[0]?.missionId ?? null;
        const replayedMission = replayMissionId
          ? missionRepo.getMissionById(replayMissionId)
          : null;
        const replayedWorkflow = replayMissionId
          ? (db.select().from(workflows).where(eq(workflows.missionId, replayMissionId)).get() ??
            null)
          : null;
        reply.code(200).send({
          mission: replayedMission,
          tasks: replayedTasks,
          workflow: replayedWorkflow,
        });
        return;
      }

      // 3. PUBLISH (atomic, inside the publisher's caller-owned tx)
      const outcome = publishTemplateAggregateWithClient(db, {
        attemptIds,
        prepared: aggregate,
      });

      // 4. MAP the closed outcome to HTTP. Mirrors the legacy
      //    `{mission, tasks, workflow}` return shape (tasks flatten to Task
      //    rows via `CommittedPublication.task`).
      switch (outcome.outcome) {
        case "published":
          reply.code(201).send({
            mission: outcome.mission,
            tasks: outcome.tasks.map((p) => p.task),
            workflow: outcome.workflow,
          });
          return;
        case "vetoed":
          // Visible blocked outcome — NET-NEW for template-application (the
          // legacy path bypasses governance entirely; this gate removes the
          // exemption). Preserve the typed publication outcome instead of
          // collapsing it into the generic AppError envelope.
          reply.code(403).send({
            outcome: "vetoed",
            vetoes: outcome.vetoes,
          });
          return;
        case "guard_mismatch":
          throw conflict("Template application guard mismatch", {
            taskIndex: outcome.taskIndex,
            reasons: outcome.reasons,
          });
        case "governance_denied":
          throw forbidden("Template application denied by governance", "GOVERNANCE_DENIED", {
            taskIndex: outcome.taskIndex,
            kind: outcome.kind,
            reason: outcome.reason,
            ...(outcome.interceptorKey !== undefined
              ? { interceptorKey: outcome.interceptorKey }
              : {}),
          });
      }
    },
  );
}
