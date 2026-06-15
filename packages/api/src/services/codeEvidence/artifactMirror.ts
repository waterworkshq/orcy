import type {
  CodeEvidenceBulkResult,
  CodeEvidenceLinkItem,
  CodeEvidenceLinkSource,
} from "@orcy/shared";

import { linkCommit, linkExternalUrl, linkParsedUrl } from "./linking.js";
import type { CodeEvidenceActor, LinkResult } from "./types.js";
import { parseUrl } from "./urlParsing.js";

/** Creates code evidence links on a task for a batch of mirrored artifacts (pull requests, commits, and pipeline logs), classifying each by type and aggregating per-artifact warnings and errors. */
export function mirrorArtifactsToCodeEvidence(
  taskId: string,
  artifacts: Array<{ type: string; url: string; description: string }>,
  actor: CodeEvidenceActor,
): CodeEvidenceBulkResult {
  const links: CodeEvidenceLinkItem[] = [];
  const warnings: Array<{ code: string; message: string; inputRef?: string }> = [];
  const errors: Array<{ code: string; message: string; inputRef?: string }> = [];

  for (const artifact of artifacts) {
    const source: CodeEvidenceLinkSource = "artifact_mirror";

    if (artifact.type === "pr") {
      const parsed = parseUrl(artifact.url);
      pushResult(
        parsed && parsed.evidenceType === "pull_request"
          ? linkParsedUrl("task", taskId, parsed, artifact.url, source, actor, null, false)
          : linkExternalUrl("task", taskId, artifact.url, source, actor, false),
        links,
        warnings,
        errors,
      );
    } else if (artifact.type === "commit") {
      pushResult(
        linkCommit(
          "task",
          taskId,
          { sha: artifact.url, message: artifact.description },
          actor,
          null,
          false,
        ),
        links,
        warnings,
        errors,
      );
    } else if (artifact.type === "log") {
      const parsed = parseUrl(artifact.url);
      pushResult(
        parsed && parsed.evidenceType === "pipeline_run"
          ? linkParsedUrl("task", taskId, parsed, artifact.url, source, actor, null, false)
          : linkExternalUrl("task", taskId, artifact.url, source, actor, false),
        links,
        warnings,
        errors,
      );
    }
  }

  return { links, warnings, errors };
}

function pushResult(
  result: LinkResult,
  links: CodeEvidenceLinkItem[],
  warnings: Array<{ code: string; message: string; inputRef?: string }>,
  errors: Array<{ code: string; message: string; inputRef?: string }>,
) {
  if (result.link) links.push(result.link);
  if (result.warning) warnings.push(result.warning);
  if (result.error) errors.push(result.error);
}
