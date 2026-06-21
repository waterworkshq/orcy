import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { humanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
import { manualUnblockGate } from "../services/workflowService.js";
import { notFound } from "../errors.js";

/** Workflow management routes — admin-gated operations on workflow gates. */
export async function workflowRoutes(fastify: FastifyInstance): Promise<void> {
  /** POST /workflows/:id/gates/:gateId/unblock - Manually satisfy an on_manual gate. Auth: humanAuth + adminOnly. Returns { satisfied: true } or 404. */
  fastify.post<{ Params: { id: string; gateId: string } }>(
    "/workflows/:id/gates/:gateId/unblock",
    { preHandler: [humanAuth, adminOnly] },
    async (
      request: FastifyRequest<{ Params: { id: string; gateId: string } }>,
      _reply: FastifyReply,
    ) => {
      const unblocked = manualUnblockGate(request.params.gateId, request.user!.id);
      if (!unblocked) {
        throw notFound("Workflow gate not found");
      }
      return { satisfied: true };
    },
  );
}
