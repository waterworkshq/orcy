import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as agentService from "../services/agentService.js";
import * as taskService from "../services/tasks/index.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";
import * as daemonRepo from "../repositories/daemon.js";
import { getSuggestionsForAgent } from "../services/taskSuggestion.js";
import { generateDaemonToken } from "../lib/daemonToken.js";
import { daemonAuth } from "../middleware/daemonAuth.js";
import { registrationAuth } from "../middleware/auth.js";
import {
  daemonRegisterSchema,
  daemonHeartbeatSchema,
  daemonClaimNextSchema,
  daemonSessionUpdateSchema,
} from "../models/schemas.js";
import type {
  DaemonRegisterInput,
  DaemonHeartbeatInput,
  DaemonClaimNextInput,
  DaemonSessionUpdateInput,
} from "../models/schemas.js";
import { badRequest, notFound, forbidden, conflict } from "../errors.js";

export async function daemonRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: DaemonRegisterInput }>(
    "/daemon/register",
    { preHandler: registrationAuth },
    async (request: FastifyRequest<{ Body: DaemonRegisterInput }>, reply: FastifyReply) => {
      const parsed = daemonRegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const { name, hostname, maxConcurrent, daemonVersion, detectedClis, habitatIds } =
        parsed.data;

      for (const hid of habitatIds) {
        const h = habitatRepo.getHabitatById(hid);
        if (!h) {
          throw badRequest(`Habitat ${hid} not found`);
        }
      }

      const plainToken = generateDaemonToken();

      const daemon = daemonRepo.createDaemon({
        name,
        hostname,
        maxConcurrent,
        daemonVersion,
        plainToken,
      });

      const agents: Array<{ id: string; name: string; type: string; apiKey: string }> = [];

      for (const cli of detectedClis) {
        const agentName = `daemon-${name}-${cli.type}`;
        const created = agentService.createAgent({
          name: agentName,
          type: cli.type as any,
          domain: "fullstack",
          capabilities: [],
          metadata: { daemonId: daemon.id, cliPath: cli.path, cliVersion: cli.version },
        });

        daemonRepo.createDaemonAgent({
          daemonId: daemon.id,
          agentId: created.agent.id,
          cliType: cli.type,
          cliVersion: cli.version ?? null,
          cliPath: cli.path,
        });

        agents.push({
          id: created.agent.id,
          name: created.agent.name,
          type: cli.type,
          apiKey: created.plainApiKey,
        });
      }

      reply.code(201);
      return {
        daemonId: daemon.id,
        daemonToken: plainToken,
        heartbeatIntervalSeconds: 30,
        agents,
      };
    },
  );

  fastify.get(
    "/daemon/sessions",
    { preHandler: daemonAuth },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const daemonId = request.daemon!.id;
      const sessions = daemonRepo.getActiveSessionsByDaemonId(daemonId);
      return { sessions };
    },
  );

  fastify.post<{ Body: DaemonHeartbeatInput }>(
    "/daemon/heartbeat",
    { preHandler: daemonAuth },
    async (request: FastifyRequest<{ Body: DaemonHeartbeatInput }>, _reply: FastifyReply) => {
      const parsed = daemonHeartbeatSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const daemonId = request.daemon!.id;
      daemonRepo.updateDaemonHeartbeat(daemonId);

      if (parsed.data.agentStatuses) {
        for (const { agentId, status } of parsed.data.agentStatuses) {
          const da = daemonRepo.getDaemonAgentByAgentId(agentId);
          if (da && da.daemonId === daemonId) {
            daemonRepo.updateDaemonAgentStatus(da.id, status);
          }
        }
      }

      if (parsed.data.sessionProgresses) {
        for (const { sessionId, lastProgress } of parsed.data.sessionProgresses) {
          const session = daemonRepo.getSessionById(sessionId);
          if (session && session.daemonId === daemonId) {
            const updates: Record<string, unknown> = {};
            if (lastProgress) updates.lastProgress = lastProgress;
            if (Object.keys(updates).length > 0) {
              daemonRepo.updateSessionProgress(sessionId, updates);
            }
          }
        }
      }

      return { nextCheckInSeconds: 30 };
    },
  );

  fastify.post<{ Body: DaemonClaimNextInput }>(
    "/daemon/tasks/claim-next",
    { preHandler: daemonAuth },
    async (request: FastifyRequest<{ Body: DaemonClaimNextInput }>, _reply: FastifyReply) => {
      const parsed = daemonClaimNextSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const daemonId = request.daemon!.id;
      const { agentId, habitatId } = parsed.data;

      if (!daemonRepo.isAgentOwnedByDaemon(agentId, daemonId)) {
        throw forbidden("Agent does not belong to this daemon");
      }

      const habitat = habitatRepo.getHabitatById(habitatId);
      if (!habitat) {
        throw badRequest(`Habitat ${habitatId} not found`);
      }

      const { suggestions } = getSuggestionsForAgent(habitatId, agentId, 10);

      for (const suggestion of suggestions) {
        const result = taskService.claimTask(suggestion.taskId, agentId);
        if (result.success) {
          const task = taskRepo.getTaskById(suggestion.taskId)!;

          daemonRepo.createDaemonSession({
            daemonId,
            agentId,
            taskId: task.id,
            habitatId,
            workdir: "pending",
          });

          return {
            task: {
              id: task.id,
              title: task.title,
              description: task.description,
              missionId: task.missionId,
              habitatId,
              priority: task.priority,
              requiredDomain: task.requiredDomain,
              requiredCapabilities: task.requiredCapabilities,
            },
            worktreeSettings: habitat.gitWorktreeSettings,
          };
        }
      }

      return _reply.code(204).send();
    },
  );

  fastify.patch<{ Params: { id: string }; Body: DaemonSessionUpdateInput }>(
    "/daemon/sessions/:id",
    { preHandler: daemonAuth },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: DaemonSessionUpdateInput }>,
      _reply: FastifyReply,
    ) => {
      const parsed = daemonSessionUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const daemonId = request.daemon!.id;
      const session = daemonRepo.getSessionById(request.params.id);

      if (!session) {
        throw notFound("Session not found");
      }

      if (session.daemonId !== daemonId) {
        throw forbidden("Session does not belong to this daemon");
      }

      const updates = parsed.data;
      if (updates.status) {
        const updated = daemonRepo.updateSessionStatus(
          session.id,
          updates.status,
          updates.lastProgress,
        );
        return { session: updated };
      }

      if (updates.lastProgress || updates.pid || updates.cliSessionId) {
        return { session };
      }

      return { session };
    },
  );
}
