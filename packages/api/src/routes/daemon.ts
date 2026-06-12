import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as daemonRepo from "../repositories/daemon.js";
import { daemonAuth } from "../middleware/daemonAuth.js";
import { registrationAuth, humanAuth } from "../middleware/auth.js";
import { adminOnly } from "../middleware/rbac.js";
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
import { badRequest, notFound, forbidden } from "../errors.js";
import * as daemonEngine from "../services/daemonEngine.js";

export async function daemonRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: DaemonRegisterInput }>(
    "/daemon/register",
    { preHandler: registrationAuth },
    async (request: FastifyRequest<{ Body: DaemonRegisterInput }>, reply: FastifyReply) => {
      const parsed = daemonRegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      const result = daemonEngine.registerHttpDaemon(parsed.data);

      reply.code(201);
      return result;
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

      const result = daemonEngine.claimNextDaemonTask({
        daemonId,
        agentId,
        habitatId,
        maxConcurrent: request.daemon!.maxConcurrent,
      });

      if (!result.claimed) {
        return _reply.code(204).send();
      }

      return result;
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
      let updated = session;
      if (updates.status) {
        updated =
          daemonRepo.updateSessionStatus(session.id, updates.status, updates.lastProgress) ??
          updated;
      }

      if (
        updates.lastProgress ||
        updates.pid !== undefined ||
        updates.workdir ||
        updates.cliSessionId
      ) {
        updated = daemonRepo.updateSessionProgress(session.id, updates) ?? updated;
      }

      return { session: updated };
    },
  );
}

export async function daemonAdminRoutes(fastify: FastifyInstance): Promise<void> {
  const adminPreHandlers = [humanAuth, adminOnly];

  fastify.get("/daemons", { preHandler: adminPreHandlers }, async () => {
    const daemons = daemonRepo.listDaemons();
    return {
      daemons: daemons.map((d) => {
        const agents = daemonRepo.getDaemonAgentsByDaemonId(d.id);
        const sessions = daemonRepo.getActiveSessionsByDaemonId(d.id);
        const isOnline =
          daemonEngine.isRunning(d.id) ||
          (d.lastHeartbeatAt && Date.now() - new Date(d.lastHeartbeatAt).getTime() < 60000);
        return {
          id: d.id,
          name: d.name,
          hostname: d.hostname,
          status: isOnline ? "online" : "offline",
          agentCount: agents.length,
          activeSessionCount: sessions.length,
          lastHeartbeat: d.lastHeartbeatAt,
          createdAt: d.createdAt,
          maxConcurrent: d.maxConcurrent,
        };
      }),
    };
  });

  fastify.get<{ Params: { id: string } }>(
    "/daemons/:id",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest<{ Params: { id: string } }>, _reply: FastifyReply) => {
      const daemon = daemonRepo.getDaemonById(request.params.id);
      if (!daemon) {
        throw notFound("Daemon not found");
      }

      const agents = daemonRepo.getDaemonAgentsByDaemonId(daemon.id);
      const sessions = daemonRepo.getActiveSessionsByDaemonId(daemon.id);
      const isOnline =
        daemonEngine.isRunning(daemon.id) ||
        (daemon.lastHeartbeatAt && Date.now() - new Date(daemon.lastHeartbeatAt).getTime() < 60000);

      return {
        daemon: {
          id: daemon.id,
          name: daemon.name,
          hostname: daemon.hostname,
          status: isOnline ? "online" : "offline",
          maxConcurrent: daemon.maxConcurrent,
          lastHeartbeat: daemon.lastHeartbeatAt,
          createdAt: daemon.createdAt,
          updatedAt: daemon.updatedAt,
        },
        agents: agents.map((a) => ({
          id: a.agentId,
          cliType: a.cliType,
          cliVersion: a.cliVersion,
          cliPath: a.cliPath,
          status: a.status,
        })),
        activeSessions: sessions.map((s) => ({
          id: s.id,
          taskId: s.taskId,
          agentId: s.agentId,
          habitatId: s.habitatId,
          status: s.status,
          startedAt: s.startedAt,
          workdir: s.workdir,
          lastProgress: s.lastProgress,
        })),
      };
    },
  );

  fastify.post<{
    Body: { name: string; habitatIds: string[]; maxConcurrent?: number; cliPreferences?: string[] };
  }>(
    "/daemons/register",
    { preHandler: adminPreHandlers },
    async (
      request: FastifyRequest<{
        Body: {
          name: string;
          habitatIds: string[];
          maxConcurrent?: number;
          cliPreferences?: string[];
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { name, habitatIds, maxConcurrent, cliPreferences } = request.body;

      if (!name || !habitatIds || habitatIds.length === 0) {
        throw badRequest("name and habitatIds are required");
      }

      const result = daemonEngine.register(name, habitatIds, maxConcurrent, cliPreferences);
      reply.code(201);
      return result;
    },
  );

  fastify.post<{ Params: { id: string }; Body?: { dataDir?: string } }>(
    "/daemons/:id/start",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest<{ Params: { id: string }; Body?: { dataDir?: string } }>) => {
      const daemon = daemonRepo.getDaemonById(request.params.id);
      if (!daemon) {
        throw notFound("Daemon not found");
      }

      if (daemonEngine.isRunning(daemon.id)) {
        return { status: "already_running" };
      }

      const dataDir = request.body?.dataDir;
      daemonEngine.start(daemon.id, dataDir);
      return { status: "started" };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/daemons/:id/stop",
    { preHandler: adminPreHandlers },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const daemon = daemonRepo.getDaemonById(request.params.id);
      if (!daemon) {
        throw notFound("Daemon not found");
      }

      await daemonEngine.stop(daemon.id);
      return { status: "stopped" };
    },
  );

  fastify.get("/daemons/detect-clis", { preHandler: adminPreHandlers }, async () => {
    const detected = daemonEngine.detectClisOnHost();
    return { clis: detected };
  });
}
