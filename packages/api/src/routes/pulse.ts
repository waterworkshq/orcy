import type { FastifyInstance } from "fastify";
import * as pulseRepo from "../repositories/pulse.js";
import * as pulseService from "../services/pulseService.js";
import * as reactionRepo from "../repositories/pulseReaction.js";
import * as missionRepo from "../repositories/mission.js";
import * as habitatRepo from "../repositories/habitat.js";
import { assertPulseNotFindingEvidence } from "../services/findingTriageHistoryGuards.js";
import { badRequest, unauthorized, notFound, forbidden } from "../errors.js";
import { AppError, ErrorCodes } from "../errors.js";
import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";

/** SQLITE_BUSY detection across drizzle wrapping and both SQLite drivers. */
function isBusyError(err: unknown): boolean {
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    if ((cause as { code?: string }).code === "SQLITE_BUSY") return true;
    if (/SQLITE_BUSY|database is locked/i.test(cause.message)) return true;
  }
  return err instanceof Error && /SQLITE_BUSY|database is locked/i.test(err.message);
}
import { getCallerInfo } from "./pulse-shared.js";
import { applyDeclaredAuthPolicies } from "../authPolicy.js";

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

export async function pulseRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.post(
    "/missions/:missionId/pulse",
    { config: { authPolicy: "local_actor" } },
    async (request, reply) => {
      const { missionId } = request.params as { missionId: string };
      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized("Authentication required");
      }
      const body = request.body as Parameters<
        typeof pulseService.postMissionPulseSignal
      >[0]["body"];

      const result = pulseService.postMissionPulseSignal({ missionId, caller, body });

      reply.code(201).send({
        pulse: result.pulse,
        linkedTask: result.linkedTask,
        blockerTaskCreated: result.blockerTaskCreated,
      });
    },
  );

  fastify.get(
    "/missions/:missionId/pulse",
    { config: { authPolicy: "local_actor" } },
    async (request, _reply) => {
      const { missionId } = request.params as { missionId: string };
      const query = request.query as {
        signalType?: string;
        signalTypes?: string;
        taskId?: string;
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
        taskId: query.taskId,
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
    { config: { authPolicy: "local_actor" } },
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

  fastify.get("/pulse/inbox", { config: { authPolicy: "local_actor" } }, async (request, _reply) => {
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

  fastify.delete("/pulse/:id", { config: { authPolicy: "local_actor" } }, async (request, reply) => {
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

    // Inverse guard (restored lifecycle T5): a Pulse referenced as source or
    // corroborating evidence by ANY Finding — terminal or not — cannot be
    // deleted; deletion erases lifecycle history. The guard and the delete
    // run under ONE `BEGIN IMMEDIATE` writer reservation — a separate
    // guard-then-delete pair left a window where a concurrent intake
    // committed evidence references between the check and the delete.
    // Contention beyond busy_timeout maps to the typed retryable 503 (the
    // shared error handler emits Retry-After), not a raw 500.
    const db = getDb();
    try {
      // Inside the try: BEGIN itself can exhaust busy_timeout and must map to
      // the typed 503 path, not escape as a generic 500.
      db.run(sql`BEGIN IMMEDIATE`);
      assertPulseNotFindingEvidence(id, db);
      const deleted = pulseRepo.deletePulseWithClient(db, id);
      db.run(sql`COMMIT`);
      if (!deleted) throw notFound("Signal not found");
    } catch (err) {
      try {
        db.run(sql`ROLLBACK`);
      } catch {
        // already rolled back or not in a transaction (defensive)
      }
      if (isBusyError(err)) {
        const busy = new AppError(
          503,
          ErrorCodes.SERVICE_UNAVAILABLE,
          "Database is busy — retry the delete after the suggested delay.",
        );
        busy.retryAfterMs = 500;
        throw busy;
      }
      throw err;
    }
    reply.code(204).send();
  });

  fastify.get("/pulse/:id/replies", { config: { authPolicy: "local_actor" } }, async (request, _reply) => {
    const { id } = request.params as { id: string };

    const pulse = pulseRepo.getPulseById(id);
    if (!pulse) {
      throw notFound("Pulse not found");
    }

    return { items: pulseRepo.getReplies(id) };
  });

  fastify.post(
    "/habitats/:habitatId/pulse",
    { config: { authPolicy: "local_actor" } },
    async (request, reply) => {
      const { habitatId } = request.params as { habitatId: string };
      const caller = getCallerInfo(request);
      if (!caller) {
        throw unauthorized("Authentication required");
      }
      const body = request.body as Parameters<
        typeof pulseService.postHabitatPulseSignal
      >[0]["body"];

      const result = pulseService.postHabitatPulseSignal({ habitatId, caller, body });

      reply.code(201).send({
        pulse: result.pulse,
        linkedTask: result.linkedTask,
        blockerTaskCreated: result.blockerTaskCreated,
      });
    },
  );

  fastify.get(
    "/habitats/:habitatId/pulse",
    { config: { authPolicy: "local_actor" } },
    async (request, _reply) => {
      const { habitatId } = request.params as { habitatId: string };
      const query = request.query as {
        signalType?: string;
        signalTypes?: string;
        scope?: string;
        taskId?: string;
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
        taskId: query.taskId,
        limit,
        offset,
      });

      return { items: result.pulses, total: result.total };
    },
  );

  fastify.get(
    "/habitats/:habitatId/pulse/digest",
    { config: { authPolicy: "local_actor" } },
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

  fastify.post("/pulse/:id/react", { config: { authPolicy: "local_actor" } }, async (request, reply) => {
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
