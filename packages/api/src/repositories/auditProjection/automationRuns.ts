import { getDb } from "../../db/index.js";
import { automationRuleRuns, automationRules } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";
import type { AutomationRule, AutomationRuleRun } from "@orcy/shared";

export interface AutomationRunAuditRow {
  run: AutomationRuleRun;
  rule: AutomationRule | null;
}

export function listForAudit(habitatId: string): AutomationRunAuditRow[] {
  const db = getDb();
  const rows = db
    .select({
      run: automationRuleRuns,
      rule: automationRules,
    })
    .from(automationRuleRuns)
    .leftJoin(automationRules, eq(automationRuleRuns.ruleId, automationRules.id))
    .where(eq(automationRuleRuns.habitatId, habitatId))
    .all();

  return rows.map((row) => ({
    run: row.run as unknown as AutomationRuleRun,
    rule: row.rule ? (row.rule as unknown as AutomationRule) : null,
  }));
}