/**
 * Extraction audit + SSE emission — subscribes to extraction lifecycle events
 * and emits SSE notifications carrying IDs and bounded state only.
 *
 * Audit events/SSE payloads contain NO raw source bodies or Experience
 * contributor data. The emitter subscribes to `onExtractionRunCompleted` and
 * emits `extraction.finding_proposed` for each newly persisted finding in the
 * completed attempt.
 *
 * This module is the extraction-side counterpart to the audit projection
 * collectors. It is registered at boot.
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
 * Register the extraction audit/SSE emitter. Called once at boot.
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
      // Find findings whose first_attempt_id matches the completed attempt
      const newFindings = db
        .select({
          id: extractedFindings.id,
          findingType: extractedFindings.findingType,
          subject: extractedFindings.subject,
          confidence: extractedFindings.confidence,
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
              subject: finding.subject,
              confidence: finding.confidence,
            },
          });
        } catch (err) {
          logger.warn({ err, findingId: finding.id }, "Failed to emit finding_proposed SSE");
        }
      }
    } catch (err) {
      logger.warn({ err, habitatId, attemptId: attempt.id }, "Extraction audit emission failed");
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
