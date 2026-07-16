import * as pulseRepo from "../repositories/pulse.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/habitat.js";

/** Result of building a daily digest for one habitat: the rendered summary and the pulse it was posted as, or null when skipped or failed. */
export interface DigestResult {
  habitatId: string;
  pulseId: string | null;
  summary: string;
}

function buildDigestText(
  habitatName: string,
  counts: {
    pending: number;
    inProgress: number;
    done: number;
    failed: number;
    submitted: number;
  },
): string {
  const lines = [`**${habitatName} Daily Digest**`, ""];

  if (counts.pending > 0)
    lines.push(`- ${counts.pending} pending task${counts.pending !== 1 ? "s" : ""} awaiting work`);
  if (counts.inProgress > 0) lines.push(`- ${counts.inProgress} in progress`);
  if (counts.submitted > 0) lines.push(`- ${counts.submitted} submitted for review`);
  if (counts.done > 0) lines.push(`- ${counts.done} completed`);
  if (counts.failed > 0) lines.push(`- ${counts.failed} failed`);

  if (lines.length === 2) {
    lines.push("- No task activity since last digest");
  }

  return lines.join("\n");
}

/** Builds a per-habitat daily task-count digest for every habitat, posting each as an automatic system pulse when there is activity. */
export function generateAllDigests(): DigestResult[] {
  const results: DigestResult[] = [];
  const habitats = habitatRepo.listHabitats();

  for (const habitat of habitats) {
    const pending = taskRepo.getTasksByHabitatId(habitat.id, { status: "pending" }).total;
    const inProgress = taskRepo.getTasksByHabitatId(habitat.id, { status: "in_progress" }).total;
    const done = taskRepo.getTasksByHabitatId(habitat.id, { status: "done" }).total;
    const failed = taskRepo.getTasksByHabitatId(habitat.id, { status: "failed" }).total;
    const submitted = taskRepo.getTasksByHabitatId(habitat.id, { status: "submitted" }).total;

    const summary = buildDigestText(habitat.name, { pending, inProgress, done, failed, submitted });

    if (pending === 0 && inProgress === 0 && done === 0 && failed === 0 && submitted === 0) {
      results.push({ habitatId: habitat.id, pulseId: null, summary });
      continue;
    }

    try {
      const pulse = pulseRepo.createPulse({
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "system",
        fromId: "scheduler",
        signalType: "context",
        subject: `Daily digest: ${habitat.name}`,
        body: summary,
        metadata: {
          nudgeType: "daily_digest",
          counts: { pending, inProgress, done, failed, submitted },
        },
        isAuto: true,
      });

      results.push({ habitatId: habitat.id, pulseId: pulse.id, summary });
    } catch (err) {
      results.push({ habitatId: habitat.id, pulseId: null, summary: `error: ${err}` });
    }
  }

  return results;
}
