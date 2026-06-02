import * as pipelineEventRepo from "../../repositories/pipelineEvent.js";
import * as prRepo from "../../repositories/pullRequest.js";
import * as taskRepo from "../../repositories/task.js";
import { ensureEvidenceLinkForPipelineEvent, ensureEvidenceLinkForPullRequest } from "./linking.js";

export function backfillExistingCodeEvidence(): {
  prCount: number;
  pipelineCount: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  let prCount = 0;
  let pipelineCount = 0;

  try {
    const prRows = prRepo.getAll({ limit: Number.MAX_SAFE_INTEGER });
    for (const pr of prRows) {
      try {
        const habitatId = taskRepo.getHabitatIdForTask(pr.taskId);
        if (!habitatId) {
          warnings.push(`PR ${pr.id}: could not resolve habitat for task ${pr.taskId}`);
          continue;
        }
        ensureEvidenceLinkForPullRequest(
          {
            id: pr.id,
            taskId: pr.taskId,
            provider: pr.provider,
            repo: pr.repo,
            prNumber: pr.prNumber,
            prTitle: pr.prTitle,
            prUrl: pr.prUrl,
            branchName: pr.branchName,
          },
          "migration",
          habitatId,
        );
        prCount++;
      } catch (err) {
        warnings.push(`PR ${pr.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`PR backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const pipelineRows = pipelineEventRepo.getAll({ limit: Number.MAX_SAFE_INTEGER });
    for (const event of pipelineRows) {
      try {
        const habitatId = taskRepo.getHabitatIdForTask(event.taskId);
        if (!habitatId) {
          warnings.push(`Pipeline ${event.id}: could not resolve habitat for task ${event.taskId}`);
          continue;
        }
        ensureEvidenceLinkForPipelineEvent(
          {
            id: event.id,
            taskId: event.taskId,
            provider: event.provider,
            repo: event.repo,
            runId: event.runId,
            branch: event.branch ?? "",
            commitSha: event.commitSha,
          },
          "migration",
          habitatId,
        );
        pipelineCount++;
      } catch (err) {
        warnings.push(`Pipeline ${event.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`Pipeline backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { prCount, pipelineCount, warnings };
}
