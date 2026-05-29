import type { FastifyInstance } from "fastify";
import * as pulseRepo from "../repositories/pulse.js";
import * as pulseService from "../services/pulseService.js";
import * as reactionRepo from "../repositories/pulseReaction.js";
import * as agentRepo from "../repositories/agent.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as taskService from "../services/tasks/index.js";
import * as habitatRepo from "../repositories/board.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";
import { badRequest, unauthorized, notFound, forbidden } from "../errors.js";
import { VALID_SIGNAL_TYPES, getCallerInfo } from "./pulse-shared.js";

function resolveAgentName(name: string): string | null {
  const agent = agentRepo.getAgentByName(name);
  return agent?.id ?? null;
}

const MAX_PAGINATION_LIMIT = 200;

function validateIso8601(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (isNaN(parsed)) throw badRequest("Invalid since parameter: must be ISO 8601");
  return new Date(parsed).toISOString();
}

function parsePagination(query: { limit?: string; offset?: string }): {
  limit: number;
  offset: number;
} {
  return {
    limit: Math.min(Math.max(parseInt(query.limit ?? "", 10) || 50, 1), MAX_PAGINATION_LIMIT),
    offset: Math.max(parseInt(query.offset ?? "", 10) || 0, 0),
  };
}

function checkReplyScope(replyToId: string | undefined, habitatId: string, scope: string): void {
  if (!replyToId) return;
  const parent = pulseRepo.getPulseById(replyToId);
  if (!parent) throw notFound("Reply target pulse not found");
  if (parent.habitatId !== habitatId) throw forbidden("Cannot reply across habitats");
  if (parent.scope !== scope) throw forbidden("Cannot reply across scopes");
}

function validateMetadata(metadata: Record<string, unknown> | undefined): void {
  if (metadata && JSON.stringify(metadata).length > 10_000) {
    throw badRequest("Metadata exceeds maximum size (10KB)");
  }
}

export async function pulseRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    "/missions/:missionId/pulse",
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { missionId } = request.params as { missionId: string };
      const body = request.body as {
        signalType?: string;
        subject?: string;
        body?: string;
        taskId?: string;
        toAgentId?: string;
        toAgentName?: string;
        replyToId?: string;
        metadata?: Record<string, unknown>;
      };

      if (!body.signalType || !body.subject) {
        throw badRequest("Missing required fields: signalType, subject");
      }

      if (!VALID_SIGNAL_TYPES.includes(body.signalType as any)) {
        throw badRequest(`Invalid signalType. Must be one of: ${VALID_SIGNAL_TYPES.join(", ")}`);
      }

      const mission = missionRepo.getMissionById(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized("Authentication required");
      }

      let toType: "human" | "agent" | undefined;
      let toId: string | undefined;

      if (body.toAgentId) {
        toType = "agent";
        toId = body.toAgentId;
      } else if (body.toAgentName) {
        const resolved = resolveAgentName(body.toAgentName);
        if (!resolved) {
          throw notFound(`Agent not found: ${body.toAgentName}`);
        }
        toType = "agent";
        toId = resolved;
      }

      checkReplyScope(body.replyToId, mission.habitatId, "mission");
      validateMetadata(body.metadata);

      const pulse = pulseService.createPulseAndNotify({
        missionId,
        habitatId: mission.habitatId,
        fromType: caller.type,
        fromId: caller.id,
        toType,
        toId,
        signalType: body.signalType as pulseRepo.SignalType,
        subject: body.subject,
        body: body.body ?? "",
        taskId: body.taskId ?? undefined,
        replyToId: body.replyToId ?? undefined,
        metadata: body.metadata ?? undefined,
      });

      let linkedTask: ReturnType<typeof taskRepo.getTaskById> = null;

      if (body.signalType === "blocker" && !mission.isArchived) {
        try {
          const task = taskService.createTask({
            missionId: missionId,
            title: `Clear Blocker: ${body.subject}`,
            description: `Auto-generated blocker clearance task.\n\nBlocker: ${body.body ?? ""}\n\nSource signal: ${pulse.id}${body.taskId ? `\nBlocked task: ${body.taskId}` : ""}`,
            priority: "high",
            labels: ["blocker-clearance"],
            createdBy: "system",
          });

          pulseRepo.updateLinkedTask(pulse.id, task.id);
          linkedTask = taskRepo.getTaskById(task.id);
        } catch (err) {
          logger.error(
            { err, missionId, pulseId: pulse.id },
            "Failed to create blocker clearance task",
          );
        }
      }

      try {
        sseBroadcaster.publish(pulse.habitatId, {
          type: "pulse.signal_posted",
          data: {
            pulseId: pulse.id,
            missionId: pulse.missionId,
            signalType: pulse.signalType,
            fromType: pulse.fromType,
            fromId: pulse.fromId,
            subject: pulse.subject,
          },
        });
      } catch (err) {
        logger.warn({ err }, "SSE broadcast failed after mission pulse creation");
      }

      reply
        .code(201)
        .send({ pulse, linkedTask: linkedTask ?? undefined, blockerTaskCreated: !!linkedTask });
    },
  );

  fastify.get(
    "/missions/:missionId/pulse",
    { preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const { missionId } = request.params as { missionId: string };
      const query = request.query as {
        signalType?: string;
        signalTypes?: string;
        isAuto?: string;
        since?: string;
        limit?: string;
        offset?: string;
      };

      const mission = missionRepo.getMissionById(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      const { limit, offset } = parsePagination(query);

      const signalTypes = query.signalTypes
        ? (query.signalTypes.split(",").filter(Boolean) as pulseRepo.SignalType[])
        : undefined;

      const result = pulseRepo.getPulsesByMission(missionId, {
        signalTypes,
        signalType: query.signalType as pulseRepo.SignalType | undefined,
        isAuto: query.isAuto !== undefined ? query.isAuto === "true" : undefined,
        since: validateIso8601(query.since),
        limit,
        offset,
      });

      return { items: result.pulses, total: result.total };
    },
  );

  fastify.get(
    "/missions/:missionId/pulse/digest",
    { preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const { missionId } = request.params as { missionId: string };

      const mission = missionRepo.getMissionById(missionId);
      if (!mission) {
        throw notFound("Mission not found");
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized("Authentication required");
      }

      return pulseRepo.getPulseDigest(missionId, caller.type, caller.id);
    },
  );

  fastify.get("/pulse/inbox", { preHandler: agentOrHumanAuth }, async (request, _reply) => {
    const query = request.query as { signalType?: string; limit?: string; offset?: string };

    const caller = getCallerInfo(request);
    if (!caller) {
      throw unauthorized("Authentication required");
    }

    const { limit, offset } = parsePagination(query);

    const result = pulseRepo.getPulsesByTarget(caller.type, caller.id, {
      signalType: query.signalType as pulseRepo.SignalType | undefined,
      limit,
      offset,
    });

    return { items: result.pulses, total: result.total };
  });

  fastify.delete("/pulse/:id", { preHandler: agentOrHumanAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const pulse = pulseRepo.getPulseById(id);
    if (!pulse) {
      throw notFound("Pulse not found");
    }

    const caller = getCallerInfo(request);
    if (!caller) {
      throw unauthorized("Authentication required");
    }

    if (pulse.fromId !== caller.id) {
      throw forbidden("Only the author can delete a signal");
    }

    pulseRepo.deletePulse(id);
    reply.code(204).send();
  });

  fastify.get("/pulse/:id/replies", { preHandler: agentOrHumanAuth }, async (request, _reply) => {
    const { id } = request.params as { id: string };

    const pulse = pulseRepo.getPulseById(id);
    if (!pulse) {
      throw notFound("Pulse not found");
    }

    return { items: pulseRepo.getReplies(id) };
  });

  fastify.post(
    "/habitats/:habitatId/pulse",
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const { habitatId } = request.params as { habitatId: string };
      const body = request.body as {
        signalType?: string;
        subject?: string;
        body?: string;
        taskId?: string;
        toAgentId?: string;
        toAgentName?: string;
        replyToId?: string;
        metadata?: Record<string, unknown>;
      };

      if (!body.signalType || !body.subject) {
        throw badRequest("Missing required fields: signalType, subject");
      }

      if (!VALID_SIGNAL_TYPES.includes(body.signalType as any)) {
        throw badRequest(`Invalid signalType. Must be one of: ${VALID_SIGNAL_TYPES.join(", ")}`);
      }

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) {
        throw notFound("Habitat not found");
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized("Authentication required");
      }

      let toType: "human" | "agent" | undefined;
      let toId: string | undefined;

      if (body.toAgentId) {
        toType = "agent";
        toId = body.toAgentId;
      } else if (body.toAgentName) {
        const resolved = resolveAgentName(body.toAgentName);
        if (!resolved) {
          throw notFound(`Agent not found: ${body.toAgentName}`);
        }
        toType = "agent";
        toId = resolved;
      }

      checkReplyScope(body.replyToId, habitatId, "habitat");
      validateMetadata(body.metadata);

      const pulse = pulseService.createPulseAndNotify({
        habitatId: habitatId,
        scope: "habitat",
        fromType: caller.type,
        fromId: caller.id,
        toType,
        toId,
        signalType: body.signalType as pulseRepo.SignalType,
        subject: body.subject,
        body: body.body ?? "",
        taskId: body.taskId ?? undefined,
        replyToId: body.replyToId ?? undefined,
        metadata: body.metadata ?? undefined,
      });

      let linkedTask: ReturnType<typeof taskRepo.getTaskById> = null;

      if (body.signalType === "blocker") {
        try {
          const task = taskService.createTask({
            missionId: habitatId,
            title: `Clear Blocker: ${body.subject}`,
            description: `Auto-generated habitat blocker clearance task.\n\nBlocker: ${body.body ?? ""}\n\nSource signal: ${pulse.id}`,
            priority: "high",
            labels: ["blocker-clearance"],
            createdBy: "system",
          });
          pulseRepo.updateLinkedTask(pulse.id, task.id);
          linkedTask = taskRepo.getTaskById(task.id);
        } catch (err) {
          logger.error(
            { err, habitatId, pulseId: pulse.id },
            "Failed to create habitat blocker clearance task",
          );
        }
      }

      try {
        sseBroadcaster.publish(habitatId, {
          type: "pulse.signal_posted",
          data: {
            pulseId: pulse.id,
            missionId: pulse.missionId,
            signalType: pulse.signalType,
            fromType: pulse.fromType,
            fromId: pulse.fromId,
            subject: pulse.subject,
          },
        });
      } catch (err) {
        logger.warn({ err }, "SSE broadcast failed after habitat pulse creation");
      }

      reply
        .code(201)
        .send({ pulse, linkedTask: linkedTask ?? undefined, blockerTaskCreated: !!linkedTask });
    },
  );

  fastify.get(
    "/habitats/:habitatId/pulse",
    { preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const { habitatId } = request.params as { habitatId: string };
      const query = request.query as {
        signalType?: string;
        signalTypes?: string;
        scope?: string;
        limit?: string;
        offset?: string;
      };
      const signalTypes = query.signalTypes
        ? (query.signalTypes.split(",").filter(Boolean) as pulseRepo.SignalType[])
        : undefined;
      const { limit, offset } = parsePagination(query);

      const result = pulseRepo.getPulsesByHabitat(habitatId, {
        signalTypes,
        signalType: query.signalType as pulseRepo.SignalType | undefined,
        scope: query.scope as pulseRepo.PulseScope | undefined,
        limit,
        offset,
      });

      return { items: result.pulses, total: result.total };
    },
  );

  fastify.get(
    "/habitats/:habitatId/pulse/digest",
    { preHandler: agentOrHumanAuth },
    async (request, _reply) => {
      const { habitatId } = request.params as { habitatId: string };

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) {
        throw notFound("Habitat not found");
      }

      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized("Authentication required");
      }

      return pulseRepo.getHabitatPulseDigest(habitatId, caller.type, caller.id);
    },
  );

  fastify.post("/pulse/:id/react", { preHandler: agentOrHumanAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { reaction?: string };

    if (!body.reaction) {
      throw badRequest("Missing required field: reaction");
    }

    const validReactions = ["seen", "ack", "question"];
    if (!validReactions.includes(body.reaction)) {
      throw badRequest(`Invalid reaction. Must be one of: ${validReactions.join(", ")}`);
    }

    const pulse = pulseRepo.getPulseById(id);
    if (!pulse) {
      throw notFound("Pulse not found");
    }

    const caller = getCallerInfo(request);
    if (!caller) {
      throw unauthorized("Authentication required");
    }

    const result = reactionRepo.toggleReaction({
      pulseId: id,
      reactorType: caller.type,
      reactorId: caller.id,
      reaction: body.reaction as reactionRepo.ReactionType,
    });

    const counts = reactionRepo.getReactionCounts(id);

    reply.code(200).send({ ...result, counts });
  });
}
