import * as daemonRepo from "../repositories/daemon.js";
import { driveDaemonSessionOutcome } from "./daemonSessionRecovery.js";
import { logger } from "../lib/logger.js";
import type { ISessionUpdater, SessionStatus } from "@orcy/shared/types";

/**
 * {@link ISessionUpdater} implementation for the API's embedded daemon.
 * Routes status and progress updates to the daemon repository in-process.
 *
 * Convergence seam (daemon-worker contract): after a TERMINAL status write
 * commits, the recovery drive runs synchronously (better-sqlite3) — its
 * task-side effects land before this async method resolves, so an awaited
 * `shutdownAll`/`stop()` covers release-effect durability. The drive is
 * void-fired with a fixed-code catch: a DB-write failure is logged
 * (`daemon_recovery_db_write_failed`) and retried by the sweep — it never
 * breaks the session write that already committed.
 */
export class InProcessSessionUpdater implements ISessionUpdater {
  async updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void> {
    if (updates.status) {
      daemonRepo.updateSessionStatus(
        sessionId,
        updates.status as SessionStatus,
        updates.lastProgress as string | undefined,
      );
      this.driveRecovery(sessionId);
    }

    if (updates.lastProgress || updates.pid || updates.workdir || updates.cliSessionId) {
      daemonRepo.updateSessionProgress(sessionId, updates);
    }
  }

  private driveRecovery(sessionId: string): void {
    try {
      driveDaemonSessionOutcome(sessionId);
    } catch {
      logger.error(
        { sessionId, errorCode: "daemon_recovery_db_write_failed" },
        "Embedded session drive failed after terminal write; sweep retries",
      );
    }
  }
}
