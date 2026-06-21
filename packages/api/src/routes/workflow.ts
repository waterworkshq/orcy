import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { humanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
import * as workflowService from "../services/workflowService.js";
import * as missionRepo from "../repositories/feature.js";
import { badRequest, conflict, notFound } from "../errors.js";

const joinSpecSchema = z.object({
  mode: z.enum(["all_of", "any_of", "n_of"]),
  n: z.number().int().positive().optional(),
});

const failureHandlerSchema = z.object({
  recoveryTaskTemplate: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    key: z.string().optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    requiredDomain: z.string().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    failureHandlerOverride: z.any().optional(),
    initialStatus: z
      .enum([
        "pending",
        "claimed",
        "in_progress",
        "submitted",
        "approved",
        "rejected",
        "done",
        "failed",
      ])
      .optional(),
  }),
  agentSelector: z
    .object({
      requiredCapabilities: z.array(z.string()).optional(),
      requiredDomain: z.string().nullable().optional(),
      assignedAgentId: z.string().optional(),
    })
    .optional(),
});

const attachWorkflowSchema = z.object({
  definition: z.object({
    gates: z
      .array(
        z.object({
          upstreamTaskKey: z.string().min(1),
          downstreamTaskKey: z.string().min(1),
          gateType: z.enum([
            "on_complete",
            "on_approve",
            "on_signal",
            "on_automation",
            "on_manual",
            "on_fail",
          ]),
          matchConfig: z.any().optional(),
          condition: z.any().nullable().optional(),
        }),
      )
      .min(1),
    joinSpecs: z.record(joinSpecSchema).optional(),
    failureHandler: failureHandlerSchema.optional(),
    variables: z
      .array(
        z.object({
          key: z.string().min(1),
          description: z.string(),
          default: z.string().optional(),
          required: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
  variables: z.record(z.string()).optional(),
});

const updateWorkflowSchema = z.object({
  expectedVersion: z.number().int().positive(),
  failureHandler: failureHandlerSchema.nullable().optional(),
  joinSpecs: z.record(joinSpecSchema).nullable().optional(),
});

/** Workflow management routes — admin-gated operations on workflow CRUD and gates. */
export async function workflowRoutes(fastify: FastifyInstance): Promise<void> {
  /** POST /missions/:id/workflow - Attach a workflow DAG to a mission. Auth: humanAuth + adminOnly. Returns { workflow } or 404/400. */
  fastify.post<{ Params: { id: string }; Body: z.infer<typeof attachWorkflowSchema> }>(
    "/missions/:id/workflow",
    { preHandler: [humanAuth, adminOnly] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: z.infer<typeof attachWorkflowSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const parsed = attachWorkflowSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) {
        throw notFound("Mission not found");
      }

      const userId = request.user!.id;
      const workflowId = workflowService.attachWorkflow(
        mission.id,
        mission.habitatId,
        parsed.data.definition,
        parsed.data.variables ?? {},
        userId,
      );

      const workflow = workflowService.getWorkflowById(workflowId);
      reply.code(201).send({ workflow });
    },
  );

  /** GET /missions/:id/workflow - Get the active workflow shape for a mission. Auth: humanAuth + adminOnly. Returns { workflow, gates } or 404. */
  fastify.get<{ Params: { id: string } }>(
    "/missions/:id/workflow",
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const mission = missionRepo.getMissionById(request.params.id);
      if (!mission) {
        throw notFound("Mission not found");
      }

      const workflow = workflowService.getWorkflowForMission(mission.id);
      if (!workflow) {
        throw notFound("No active workflow attached to this mission");
      }

      const gates = workflowService.getWorkflowShape(workflow.id);
      return { workflow, gates };
    },
  );

  /** PATCH /workflows/:id - Update workflow config (failureHandler/joinSpecs) with OCC. Auth: humanAuth + adminOnly. Returns { workflow } or 404/409. */
  fastify.patch<{ Params: { id: string }; Body: z.infer<typeof updateWorkflowSchema> }>(
    "/workflows/:id",
    { preHandler: [humanAuth, adminOnly] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: z.infer<typeof updateWorkflowSchema>;
      }>,
      _reply: FastifyReply,
    ) => {
      const parsed = updateWorkflowSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const result = workflowService.updateWorkflow(
        request.params.id,
        {
          failureHandler: parsed.data.failureHandler,
          joinSpecs: parsed.data.joinSpecs,
        },
        parsed.data.expectedVersion,
      );

      if (!result.ok) {
        if (result.reason === "not_found") {
          throw notFound("Workflow not found");
        }
        throw conflict("Workflow version mismatch", { currentVersion: result.currentVersion });
      }

      return { workflow: result.workflow };
    },
  );

  /** DELETE /workflows/:id - Detach a workflow (status becomes "detached"; gates stop enforcing). Auth: humanAuth + adminOnly. Returns { detached: true } or 404. */
  fastify.delete<{ Params: { id: string } }>(
    "/workflows/:id",
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const existing = workflowService.getWorkflowById(request.params.id);
      if (!existing) {
        throw notFound("Workflow not found");
      }

      workflowService.detachWorkflow(request.params.id, request.user!.id);
      return { detached: true };
    },
  );

  /** GET /workflows/:id/failure-contexts - List failure contexts for a workflow. Auth: humanAuth + adminOnly. Returns { failureContexts } or 404. */
  fastify.get<{ Params: { id: string } }>(
    "/workflows/:id/failure-contexts",
    { preHandler: [humanAuth, adminOnly] },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const existing = workflowService.getWorkflowById(request.params.id);
      if (!existing) {
        throw notFound("Workflow not found");
      }

      const failureContexts = workflowService.getFailureContextsForWorkflow(request.params.id);
      return { failureContexts };
    },
  );

  /** POST /workflows/:id/gates/:gateId/unblock - Manually satisfy an on_manual gate. Auth: humanAuth + adminOnly. Returns { satisfied: true } or 404. */
  fastify.post<{ Params: { id: string; gateId: string } }>(
    "/workflows/:id/gates/:gateId/unblock",
    { preHandler: [humanAuth, adminOnly] },
    async (
      request: FastifyRequest<{ Params: { id: string; gateId: string } }>,
      _reply: FastifyReply,
    ) => {
      const unblocked = workflowService.manualUnblockGate(request.params.gateId, request.user!.id);
      if (!unblocked) {
        throw notFound("Workflow gate not found");
      }
      return { satisfied: true };
    },
  );
}
