import { normalizeMissionId } from "@orcy/shared";
import { logger } from "../logger.js";
import type { MissionContext } from "../types.js";
import type { MissionClient } from "../api/interfaces.js";
import type { PulseClient } from "../api/interfaces.js";
import type { InsightClient } from "../api/interfaces.js";
import type { SkillClient } from "../api/interfaces.js";
import type { Mission, MissionWithProgress } from "@orcy/shared";

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildRelevanceTags(mission: Mission): string[] {
  const tags: string[] = [];
  if (mission.labels) {
    for (const label of mission.labels) {
      tags.push(`label:${label}`);
    }
  }
  return tags;
}

export interface MissionContextClients {
  mission: MissionClient;
  pulse: PulseClient;
  insight: InsightClient;
  skill: SkillClient;
}

export async function composeMissionContext(
  clients: MissionContextClients,
  rawMissionId: string,
): Promise<MissionContext> {
  const missionId = normalizeMissionId(rawMissionId);
  const details = await clients.mission.getMissionDetails(missionId);

  const depIds = details.dependencies?.dependsOn ?? [];
  const blockIds = details.dependencies?.blocks ?? [];

  const [depResults, blockResults, pulseDigest, projectInsights, skillResult] = await Promise.all([
    Promise.all(
      depIds.map((id) =>
        clients.mission
          .getMission(id)
          .then((res) => res.mission)
          .catch((err) => {
            logger.warn("mission_context_dependency_fetch_failed", {
              missionId,
              dependencyMissionId: id,
              err: getErrorMessage(err),
            });
            return undefined;
          }),
      ),
    ),
    Promise.all(
      blockIds.map((id) =>
        clients.mission
          .getMission(id)
          .then((res) => res.mission)
          .catch((err) => {
            logger.warn("mission_context_blocking_fetch_failed", {
              missionId,
              blockingMissionId: id,
              err: getErrorMessage(err),
            });
            return undefined;
          }),
      ),
    ),
    clients.pulse.getPulseDigest(missionId).catch((err) => {
      logger.warn("mission_context_pulse_digest_fetch_failed", {
        missionId,
        err: getErrorMessage(err),
      });
      return undefined;
    }),
    (async () => {
      try {
        const tags = buildRelevanceTags(details.mission);
        if (tags.length > 0) {
          return await clients.insight.getRelevantInsights(details.mission.habitatId, tags);
        }
      } catch (err) {
        logger.warn("mission_context_project_insights_fetch_failed", {
          missionId,
          habitatId: details.mission.habitatId,
          err: getErrorMessage(err),
        });
      }
      return [];
    })(),
    clients.skill
      .getHabitatSkill(details.mission.habitatId)
      .then((res) =>
        res?.skill
          ? {
              content: res.skill.content,
              signalCount: res.skill.signalCount,
              avgStrength: res.skill.avgStrength,
            }
          : undefined,
      )
      .catch((err) => {
        logger.warn("mission_context_habitat_skill_fetch_failed", {
          missionId,
          habitatId: details.mission.habitatId,
          err: getErrorMessage(err),
        });
        return undefined;
      }),
  ]);

  return {
    mission: details.mission,
    tasks: details.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      result: t.result,
      artifacts: t.artifacts,
      assignedAgentId: t.assignedAgentId,
    })),
    dependencies: depResults.filter((m): m is MissionWithProgress => m !== undefined),
    blocking: blockResults.filter((m): m is MissionWithProgress => m !== undefined),
    pulse: pulseDigest,
    projectInsights: projectInsights ?? [],
    skill: skillResult,
  };
}
