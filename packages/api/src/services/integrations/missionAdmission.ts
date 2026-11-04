import { sql } from "drizzle-orm";
import type { ExternalIssue, IntegrationConnection } from "@orcy/shared";
import { getDb } from "../../db/index.js";
import { badRequest, conflict, notFound } from "../../errors.js";
import { resolveImportColumn } from "../../repositories/column.js";
import * as candidateRepo from "../../repositories/externalIntakeCandidate.js";
import * as linkRepo from "../../repositories/externalIssueLink.js";
import * as missionRepo from "../../repositories/mission.js";

type Input =
  | { kind: "automatic"; connection: IntegrationConnection; issue: ExternalIssue; columnId: string }
  | { kind: "promotion"; candidateId: string; createdBy: string; verifyAccess: (habitatId: string) => void };

type Result =
  | { kind: "existing"; link: NonNullable<ReturnType<typeof linkRepo.getById>> }
  | { kind: "created"; mission: ReturnType<typeof missionRepo.createMissionWithClient>; link: NonNullable<ReturnType<typeof linkRepo.getById>>; candidate: ReturnType<typeof candidateRepo.getById> };

function linkIdentityConflict(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { message?: unknown; cause?: unknown };
    const message = String(value.message ?? "");
    if (/UNIQUE constraint failed: external_issue_links\.(?:provider, external_issue_links\.external_id|connection_id, external_issue_links\.external_id)/i.test(message)) return true;
    current = value.cause;
  }
  return false;
}

export function admitWorkSourceMission(input: Input): Result {
  const client = getDb();
  client.run(sql`BEGIN IMMEDIATE`);
  try {
    let missionInput: missionRepo.CreateMissionInput;
    let linkInput: Omit<Parameters<typeof linkRepo.create>[0], "missionId">;
    let candidateId: string | undefined;

    if (input.kind === "automatic") {
      const { connection, issue, columnId } = input;
      const existing = linkRepo.findByConnectionAndExternalId(connection.id, issue.externalId);
      if (existing) {
        client.run(sql`COMMIT`);
        return { kind: "existing", link: existing };
      }
      if (linkRepo.findByProviderAndExternalId(issue.provider, issue.externalId)) {
        throw conflict("External issue is already linked");
      }
      missionInput = { habitatId: connection.habitatId, columnId, title: issue.title,
        description: issue.body || "", priority: "medium", labels: [...issue.labels, `external:${issue.provider}`],
        createdBy: connection.createdBy };
      linkInput = { connectionId: connection.id, habitatId: connection.habitatId,
        provider: issue.provider, externalId: issue.externalId, externalKey: issue.externalKey,
        externalUrl: issue.url, externalStatus: issue.status, externalUpdatedAt: issue.updatedAt,
        providerLabels: issue.labels };
    } else {
      const candidate = candidateRepo.getById(input.candidateId);
      if (!candidate) throw notFound("Candidate not found");
      input.verifyAccess(candidate.habitatId);
      if (candidate.reviewStatus === "promoted") throw badRequest("Candidate has already been promoted");
      const col = resolveImportColumn(candidate.habitatId);
      if (!col) throw badRequest("No import column found for habitat");
      if (linkRepo.findByConnectionAndExternalId(candidate.connectionId, candidate.externalId) ||
          linkRepo.findByProviderAndExternalId(candidate.provider, candidate.externalId)) {
        throw conflict("External issue is already linked");
      }
      candidateId = candidate.id;
      missionInput = { habitatId: candidate.habitatId, columnId: col.columnId,
        title: candidate.sourceTitle, description: candidate.sourceBody || "", priority: "medium",
        labels: [...candidate.sourceLabels, `external:${candidate.provider}`], createdBy: input.createdBy };
      linkInput = { connectionId: candidate.connectionId, habitatId: candidate.habitatId,
        provider: candidate.provider, externalId: candidate.externalId, externalKey: candidate.externalKey,
        externalUrl: candidate.externalUrl, externalStatus: candidate.sourceStatus === "closed" ? "closed" : "open",
        providerLabels: candidate.sourceLabels };
    }

    const mission = missionRepo.createMissionWithClient(client, missionInput);
    let link: ReturnType<typeof linkRepo.create>;
    try {
      link = linkRepo.create({ ...linkInput, missionId: mission.id });
    } catch (error) {
      // Only this link INSERT can translate its actual identity conflicts.
      if (linkIdentityConflict(error)) throw conflict("External issue is already linked");
      throw error;
    }
    let candidate: ReturnType<typeof candidateRepo.getById> = null;
    if (candidateId) {
      candidate = candidateRepo.update(candidateId, { reviewStatus: "promoted", promotedMissionId: mission.id });
      if (!candidate || candidate.reviewStatus !== "promoted" || candidate.promotedMissionId !== mission.id) {
        throw new Error("Candidate admission readback mismatch");
      }
    }
    client.run(sql`COMMIT`);
    return { kind: "created", mission, link, candidate };
  } catch (error) {
    try { client.run(sql`ROLLBACK`); } catch { /* retain the original error */ }
    throw error;
  }
}
