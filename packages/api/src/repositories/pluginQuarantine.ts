/**
 * Persistent plugin quarantine repository (ADR-0016, v0.22.3).
 *
 * The in-memory `quarantineSet` in pluginManager is ephemeral; this repo persists
 * quarantine state so it survives API restarts. pluginManager loads all rows at
 * boot and writes here when a plugin is quarantined.
 */
import { getDb } from "../db/index.js";
import { pluginQuarantines } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

/** Lists all persistent quarantine rows (loaded at boot to populate the in-memory set). */
export function listAll(): {
  pluginKey: string;
  pluginId: string;
  quarantinedAt: string;
  reason: string | null;
}[] {
  const db = getDb();
  return db.select().from(pluginQuarantines).all();
}

/** Persists a quarantine entry. Idempotent — re-inserting the same key is a no-op. */
export function upsert(pluginKey: string, pluginId: string, reason?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .select({ pluginKey: pluginQuarantines.pluginKey })
    .from(pluginQuarantines)
    .where(eq(pluginQuarantines.pluginKey, pluginKey))
    .get();
  if (existing) return;
  db.insert(pluginQuarantines)
    .values({ pluginKey, pluginId, quarantinedAt: now, reason: reason ?? null })
    .run();
}

/** Removes a quarantine entry (admin clear-quarantine). Returns true if a row was deleted. */
export function remove(pluginKey: string): boolean {
  const db = getDb();
  const existing = db
    .select({ pluginKey: pluginQuarantines.pluginKey })
    .from(pluginQuarantines)
    .where(eq(pluginQuarantines.pluginKey, pluginKey))
    .get();
  if (!existing) return false;
  db.delete(pluginQuarantines).where(eq(pluginQuarantines.pluginKey, pluginKey)).run();
  return true;
}

/** Lists quarantined plugin keys for a specific habitat (via enrollment join pattern). */
export function listByPluginId(
  pluginId: string,
): { pluginKey: string; quarantinedAt: string; reason: string | null }[] {
  const db = getDb();
  return db
    .select({
      pluginKey: pluginQuarantines.pluginKey,
      quarantinedAt: pluginQuarantines.quarantinedAt,
      reason: pluginQuarantines.reason,
    })
    .from(pluginQuarantines)
    .where(eq(pluginQuarantines.pluginId, pluginId))
    .all();
}
