import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { daemonInstances, daemonSessions } from "../db/schema/index.js";
import * as daemonRepo from "../repositories/daemon.js";
import { conflict, notFound } from "../errors.js";
import { daemonStopIntentRef, isDaemonStopOwnerTerminated } from "./daemonOwnerWitness.js";

/** Retire only the observed intent of a proven-dead owner with no active sessions. */
export function recoverDaemonStop(daemonId: string, expectedIntent: string): void {
  const daemon = daemonRepo.getDaemonById(daemonId);
  if (!daemon) throw notFound("Daemon not found");
  const intent = daemon.stopIntent;
  if (!intent || daemonStopIntentRef(intent) !== expectedIntent) {
    throw conflict("Stop intent changed or has no verifiable owner; refresh the daemon status");
  }
  if (!isDaemonStopOwnerTerminated(intent)) {
    throw conflict("Stop owner termination cannot be verified; daemon remains unknown");
  }

  getDb().transaction((tx) => {
    const current = tx.select({ stopIntent: daemonInstances.stopIntent }).from(daemonInstances)
      .where(eq(daemonInstances.id, daemonId)).get();
    if (!current || current.stopIntent !== intent) {
      throw conflict("Stop intent changed; refresh the daemon status");
    }
    const active = tx.select({ id: daemonSessions.id }).from(daemonSessions)
      .where(and(eq(daemonSessions.daemonId, daemonId),
        or(isNull(daemonSessions.status), notInArray(daemonSessions.status, ["completed", "failed", "released", "lost"]))))
      .limit(1).get();
    if (active) {
      throw conflict("Active or unrecognized sessions prevent recovery; allow normal session recovery to finish");
    }
    const updated = tx.update(daemonInstances)
      .set({ status: "offline", stopIntent: null, updatedAt: new Date().toISOString() })
      .where(and(eq(daemonInstances.id, daemonId), eq(daemonInstances.stopIntent, intent)))
      .returning({ id: daemonInstances.id }).get();
    if (!updated) throw conflict("Stop intent changed; refresh the daemon status");
  }, { behavior: "immediate" });
}
