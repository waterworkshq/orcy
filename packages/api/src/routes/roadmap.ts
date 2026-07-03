import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, and, asc } from "drizzle-orm";
import { missions, missionDependencies, releases as releasesTable } from "../db/schema/index.js";
import { getDb } from "../db/index.js";
import { priorityOrderExpr } from "../db/sql-helpers.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { requireHabitat } from "./middleware/preHandlers.js";
import { getHabitatById } from "../repositories/board.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import { forbidden, unauthorized, notFound } from "../errors.js";
import * as releaseRepo from "../repositories/release.js";
import { matchesReleaseType, matchesReleaseVersion, type ReleaseType } from "@orcy/shared";

const habitatIdParamsSchema = z.object({ habitatId: z.string() });

/**
 * Roadmap DAG surface (ADR-0032 / ADR-0033). Returns the habitat's mission
 * graph (with release-gate fields), dependency edges, the nextInLine set
 * (gate-satisfied + dependency-met, ordered by priority then displayOrder),
 * and recent detected releases. Read-only — fed to the triage investigation
 * agent so it can position deferred corrective work in the DAG.
 */
export async function roadmapRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/roadmap",
    {
      schema: { params: habitatIdParamsSchema },
      preHandler: [agentOrHumanAuth, requireHabitat()],
    },
    async (request) => {
      const { habitatId } = request.params;

      // Habitat membership check (mirrors triage verifyHabitatAccess pattern)
      const habitat = getHabitatById(habitatId);
      if (!habitat) throw notFound("Habitat not found");
      if (request.agent) {
        if (habitat.teamId)
          throw forbidden("Agents cannot access team habitats", "BOARD_ACCESS_DENIED");
      } else if (request.user) {
        if (habitat.teamId && !isTeamMemberByHabitatId(habitatId, request.user.id)) {
          throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
        }
      } else {
        throw unauthorized("Authentication required");
      }

      const db = getDb();

      const priorityOrder = priorityOrderExpr(missions.priority);
      const missionRows = db
        .select()
        .from(missions)
        .where(and(eq(missions.habitatId, habitatId), eq(missions.isArchived, false)))
        .orderBy(asc(missions.displayOrder), priorityOrder, asc(missions.createdAt))
        .all();

      const depRows = db
        .select({
          missionId: missionDependencies.missionId,
          dependsOnId: missionDependencies.dependsOnId,
        })
        .from(missionDependencies)
        .innerJoin(missions, eq(missionDependencies.missionId, missions.id))
        .where(eq(missions.habitatId, habitatId))
        .all();

      const recentReleases = releaseRepo.findRecentByHabitat(habitatId, 10);
      const habitatReleaseTypes = new Set(
        db
          .select({ releaseType: releasesTable.releaseType })
          .from(releasesTable)
          .where(eq(releasesTable.habitatId, habitatId))
          .all()
          .map((r) => r.releaseType as ReleaseType),
      );
      const habitatReleaseVersions = db
        .select({ version: releasesTable.version })
        .from(releasesTable)
        .where(eq(releasesTable.habitatId, habitatId))
        .all()
        .map((r) => r.version);

      const missionById = new Map(missionRows.map((m) => [m.id, m]));
      const blockingMissionsByMission = new Map<string, Set<string>>();
      for (const dep of depRows) {
        const blockedId = dep.missionId;
        const blockerId = dep.dependsOnId;
        if (!missionById.has(blockedId)) continue;
        const entry = blockingMissionsByMission.get(blockedId) ?? new Set<string>();
        entry.add(blockerId);
        blockingMissionsByMission.set(blockedId, entry);
      }

      const nextInLine = missionRows
        .filter((m) => {
          if (m.status === "done" || m.status === "failed") return false;
          const blockers = blockingMissionsByMission.get(m.id);
          if (blockers) {
            for (const blockerId of blockers) {
              const blocker = missionById.get(blockerId);
              if (blocker && blocker.status !== "done") return false;
            }
          }
          if (m.releaseGateType || m.releaseGateVersion) {
            const typeArm = m.releaseGateType
              ? [...habitatReleaseTypes].some((shipped) =>
                  matchesReleaseType(m.releaseGateType as ReleaseType, shipped),
                )
              : false;
            const versionArm = m.releaseGateVersion
              ? habitatReleaseVersions.some((v) => matchesReleaseVersion(m.releaseGateVersion!, v))
              : false;
            if (!typeArm && !versionArm) return false;
          }
          return true;
        })
        .map((m) => m.id);

      return {
        missions: missionRows.map((m) => ({
          id: m.id,
          title: m.title,
          status: m.status,
          releaseGateType: m.releaseGateType,
          releaseGateVersion: m.releaseGateVersion,
          priority: m.priority,
          displayOrder: m.displayOrder,
        })),
        dependencies: depRows.map((d) => ({ missionId: d.missionId, dependsOnId: d.dependsOnId })),
        nextInLine,
        recentReleases: recentReleases.map((r) => ({
          version: r.version,
          releaseType: r.releaseType,
          detectedAt: r.detectedAt,
        })),
      };
    },
  );
}
