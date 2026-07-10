import { getDb } from "../../db/index.js";
import { pluginRuns } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";
import type { PluginRunRow } from "../../db/schema/index.js";

export function listForAudit(habitatId: string): PluginRunRow[] {
  const db = getDb();
  return db
    .select()
    .from(pluginRuns)
    .where(eq(pluginRuns.habitatId, habitatId))
    .all() as PluginRunRow[];
}