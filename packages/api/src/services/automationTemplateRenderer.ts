import type { AutomationEvaluationContext } from "./automationContextBuilder.js";

const ALLOWED_TOKENS = new Set([
  "task.id",
  "task.title",
  "task.description",
  "task.priority",
  "task.status",
  "task.assignedAgentId",
  "task.delegatedToAgentId",
  "task.requiredDomain",
  "task.rejectedCount",
  "task.labels",
  "task.createdBy",
  "task.estimatedMinutes",
  "task.actualMinutes",
  "mission.id",
  "mission.title",
  "mission.status",
  "mission.priority",
  "mission.dueAt",
  "mission.slaMinutes",
  "mission.createdBy",
  "habitat.id",
  "habitat.name",
  "agent.id",
  "agent.name",
  "agent.type",
  "agent.domain",
  "agent.status",
  "sprint.id",
  "sprint.name",
  "sprint.status",
  "sprint.startDate",
  "sprint.endDate",
  "trigger.eventType",
  "trigger.eventId",
  "trigger.targetType",
  "trigger.targetId",
  "raw",
]);

export interface RenderedTemplate {
  rendered: string;
  warnings: string[];
}

function extractFields(src: object | null): Record<string, unknown> {
  if (!src) return {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    result[key] = (src as Record<string, unknown>)[key];
  }
  return result;
}

export function renderTemplate(
  template: string,
  ctx: AutomationEvaluationContext,
  extra?: Record<string, unknown>,
): RenderedTemplate {
  const warnings: string[] = [];

  const merged: Record<string, unknown> = {};

  const sources: Array<[string, object | null]> = [
    ["task", ctx.task as unknown as object | null],
    ["mission", ctx.mission as unknown as object | null],
    ["habitat", ctx.habitat as unknown as object | null],
    ["agent", ctx.agent as unknown as object | null],
    ["sprint", ctx.sprint as unknown as object | null],
  ];

  for (const [prefix, src] of sources) {
    const fields = extractFields(src);
    for (const key of Object.keys(fields)) {
      merged[`${prefix}.${key}`] = fields[key];
    }
  }

  if (extra) {
    Object.assign(merged, extra);
  }

  let rendered = template.replace(/\{\{(\S+)\}\}/g, (_full, token: string) => {
    const key = token.trim();
    if (!ALLOWED_TOKENS.has(key)) {
      warnings.push(`Unknown template token: ${key}`);
      return `{{${key}}}`;
    }
    if (merged[key] === null || merged[key] === undefined) {
      return `{{${key}}}`;
    }
    const value = merged[key];
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  });

  return { rendered, warnings };
}
