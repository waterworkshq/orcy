/**
 * Extraction SSE emission — subscribes to extraction lifecycle events and emits
 * SSE notifications carrying IDs and bounded state only.
 *
 * SSE payloads contain NO raw source bodies, Experience contributor data, or
 * finding subject text. The emitter subscribes to `onExtractionRunCompleted`
 * and emits `extraction.finding_proposed` for each newly persisted finding.
 *
 * The durable audit-projection collector is deferred — SSE is an ephemeral
 * notification surface, not an audit counterpart. It is registered at boot.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { extractedFindings } from "../db/schema/index.js";
import { onExtractionRunCompleted } from "./extractionRunLifecycle.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { logger } from "../lib/logger.js";

let registered = false;
let unsubscribe: (() => void) | null = null;

/**
 * Register the extraction SSE emitter. Called once at boot.
 * Emits `extraction.finding_proposed` for new findings after each completed run.
 */
export function registerExtractionAuditEmitter(): void {
  if (registered) return;
  registered = true;

  unsubscribe = onExtractionRunCompleted((opts) => {
    const { habitatId, attempt, outcome } = opts;
    if (outcome === "failed") return;

    try {
      const db = getDb();
      // Find findings whose first_attempt_id matches the completed attempt.
      // I4 fix: Select IDs and bounded state only — NO subject text in SSE payloads.
      const newFindings = db
        .select({
          id: extractedFindings.id,
          findingType: extractedFindings.findingType,
        })
        .from(extractedFindings)
        .where(eq(extractedFindings.firstAttemptId, attempt.id))
        .all();

      for (const finding of newFindings) {
        try {
          sseBroadcaster.publish(habitatId, {
            type: "extraction.finding_proposed",
            data: {
              habitatId,
              findingId: finding.id,
              findingType: finding.findingType,
            },
          });
        } catch (err) {
          logger.warn({ err, findingId: finding.id }, "Failed to emit finding_proposed SSE");
        }
      }
    } catch (err) {
      logger.warn({ err, habitatId, attemptId: attempt.id }, "Extraction SSE emission failed");
    }
  });
}

/** Unregister the emitter (test cleanup). */
export function unregisterExtractionAuditEmitter(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  registered = false;
}
