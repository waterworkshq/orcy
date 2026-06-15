import * as daemonRepo from "../repositories/daemon.js";
import type { ISessionUpdater, SessionStatus } from "@orcy/shared/types";

/** {@link ISessionUpdater} implementation for the API's embedded daemon. Routes status and progress updates to the daemon repository in-process. */
export class InProcessSessionUpdater implements ISessionUpdater {
  async updateSession(sessionId: string, updates: Record<string, unknown>): Promise<void> {
    let session = null;
    if (updates.status) {
      session = daemonRepo.updateSessionStatus(
        sessionId,
        updates.status as SessionStatus,
        updates.lastProgress as string | undefined,
      );
    }

    if (updates.lastProgress || updates.pid || updates.workdir || updates.cliSessionId) {
      session = daemonRepo.updateSessionProgress(sessionId, updates);
    }

    void session;
  }
}
