import * as repo from "../repositories/habitatSkill.js";
import type {
  HabitatSkillSignal,
  SkillCategory,
  CreateSignalInput,
} from "../repositories/habitatSkill.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";
import * as pulseService from "./pulseService.js";
import * as taskLifecycle from "./tasks/task-lifecycle.js";
import * as commentService from "./commentService.js";
import { logger } from "../lib/logger.js";

const SKILL_CATEGORY_MAP: Record<string, SkillCategory> = {
  finding: "convention",
  directive: "convention",
  context: "domain_knowledge",
  warning: "pitfall",
  blocker: "pitfall",
  handoff: "agent_insight",
};

export function classifyPulseToCategory(signalType: string): SkillCategory {
  return SKILL_CATEGORY_MAP[signalType] ?? "agent_insight";
}

export function normalize(subject: string): string {
  const cleaned = subject
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const prefix = cleaned.slice(0, 80);
  const hash = hashCode(cleaned).toString(36);
  return `${prefix}#${hash}`;
}

function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function recalculateCrossMissionCounts(habitatId: string, allSignals: HabitatSkillSignal[]): void {
  const byCluster = new Map<string, HabitatSkillSignal[]>();
  for (const s of allSignals) {
    const arr = byCluster.get(s.clusterKey) ?? [];
    arr.push(s);
    byCluster.set(s.clusterKey, arr);
  }

  for (const [, matching] of byCluster) {
    if (matching.length < 2) continue;
    const missions = new Set<string>();
    const taskIds = [...new Set(matching.flatMap((s) => parseJsonArray(s.sourceTaskIds)))];
    for (const id of taskIds) {
      const task = taskRepo.getTaskById(id);
      if (task?.missionId) missions.add(task.missionId);
    }

    const crossCount = missions.size;
    if (crossCount >= 2) {
      for (const sig of matching) {
        if (sig.crossMissionCount !== crossCount) {
          repo.updateSignal(sig.id, { crossMissionCount: crossCount });
        }
      }
    }
  }
}

function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return [];
  }
}

function ingestSignal(signal: {
  habitatId: string;
  skillCategory: SkillCategory;
  sourceSignalType: string;
  subject: string;
  content: string;
  sourceType: "pulse" | "task_event" | "comment";
  sourceId: string;
  agentId?: string;
}): void {
  const normalized = normalize(signal.subject);
  if (!normalized) return;

  const existing = repo.findSignalByClusterKey(signal.habitatId, normalized);

  if (existing) {
    const sourceIdField =
      signal.sourceType === "pulse"
        ? "sourcePulseIds"
        : signal.sourceType === "task_event"
          ? "sourceTaskIds"
          : "sourceCommentIds";
    const sourceIds = parseJsonArray(existing[sourceIdField]);

    if (sourceIds.includes(signal.sourceId)) return;

    sourceIds.push(signal.sourceId);

    const existingAgentIds = parseJsonArray(existing.corroboratingAgentIds);
    const agentSet = new Set([...existingAgentIds, signal.agentId].filter(Boolean) as string[]);

    const updates: Partial<HabitatSkillSignal> = {
      frequency: existing.frequency + 1,
      lastSeenAt: new Date().toISOString(),
      corroboratingAgents: agentSet.size,
      corroboratingAgentIds: JSON.stringify([...agentSet]),
    };

    if (sourceIdField === "sourcePulseIds") updates.sourcePulseIds = JSON.stringify(sourceIds);
    else if (sourceIdField === "sourceTaskIds") {
      updates.sourceTaskIds = JSON.stringify(sourceIds);
      // failedTasks = count of distinct task events corroborating this signal pattern
      updates.failedTasks = existing.failedTasks + 1;
    } else if (sourceIdField === "sourceCommentIds")
      updates.sourceCommentIds = JSON.stringify(sourceIds);

    repo.updateSignal(existing.id, updates);
  } else {
    const input: CreateSignalInput = {
      habitatId: signal.habitatId,
      clusterKey: normalized,
      skillCategory: signal.skillCategory,
      sourceSignalType: signal.sourceSignalType,
      sourceType: signal.sourceType,
      subject: signal.subject,
      summary: signal.content || undefined,
      agentId: signal.agentId,
    };

    if (signal.sourceType === "pulse") input.sourcePulseId = signal.sourceId;
    else if (signal.sourceType === "task_event") {
      input.sourceTaskId = signal.sourceId;
      input.initialFailedTasks = 1;
    } else if (signal.sourceType === "comment") input.sourceCommentId = signal.sourceId;

    repo.createSignal(input);
  }
}

export function ingestFromPulse(opts: {
  habitatId: string;
  signalType: string;
  subject: string;
  body: string;
  pulseId: string;
  fromType: "human" | "agent" | "system";
  fromId: string;
}): void {
  try {
    if (
      opts.fromType === "system" ||
      opts.signalType === "question" ||
      opts.signalType === "answer"
    )
      return;
    const skillCategory = classifyPulseToCategory(opts.signalType);
    ingestSignal({
      habitatId: opts.habitatId,
      skillCategory,
      sourceSignalType: opts.signalType,
      subject: opts.subject,
      content: opts.body,
      sourceType: "pulse",
      sourceId: opts.pulseId,
      agentId: opts.fromId,
    });
  } catch (err) {
    logger.error({ err }, "Habitat skill signal ingestion failed (pulse)");
  }
}

export function ingestFromTaskEvent(opts: {
  habitatId: string;
  eventType: string;
  taskTitle: string;
  reason?: string;
  taskId: string;
  associatedAgentId?: string;
}): void {
  try {
    if (opts.eventType !== "rejected" && opts.eventType !== "failed") return;
    ingestSignal({
      habitatId: opts.habitatId,
      skillCategory: "pitfall",
      sourceSignalType: opts.eventType === "rejected" ? "warning" : "blocker",
      subject: `${opts.eventType === "rejected" ? "Rejection" : "Failure"}: ${opts.taskTitle}`,
      content: opts.reason ?? "",
      sourceType: "task_event",
      sourceId: opts.taskId,
      agentId: opts.associatedAgentId,
    });
  } catch (err) {
    logger.error({ err }, "Habitat skill signal ingestion failed (task event)");
  }
}

export function ingestFromTaskSuccess(opts: {
  habitatId: string;
  taskTitle: string;
  taskId: string;
  associatedAgentId?: string;
}): void {
  try {
    const normalized = normalize(opts.taskTitle);
    if (!normalized) return;

    let existing = repo.findSignalByClusterKey(opts.habitatId, normalized);
    if (!existing) {
      const rejectionKey = normalize(`Rejection: ${opts.taskTitle}`);
      existing = rejectionKey ? repo.findSignalByClusterKey(opts.habitatId, rejectionKey) : null;
    }
    if (!existing) {
      const failureKey = normalize(`Failure: ${opts.taskTitle}`);
      existing = failureKey ? repo.findSignalByClusterKey(opts.habitatId, failureKey) : null;
    }

    if (existing) {
      repo.updateSignal(existing.id, {
        successfulTasks: existing.successfulTasks + 1,
        lastSeenAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    logger.error({ err }, "Habitat skill signal ingestion failed (task success)");
  }
}

export function ingestFromComment(opts: {
  habitatId: string;
  taskId: string;
  content: string;
  authorType: "human" | "agent";
  authorId: string;
  commentId: string;
}): void {
  try {
    if (opts.authorType === "human") return;
    const subject =
      opts.content.length > 120 ? opts.content.slice(0, 120).trimEnd() + "..." : opts.content;
    ingestSignal({
      habitatId: opts.habitatId,
      skillCategory: "agent_insight",
      sourceSignalType: "agent_comment",
      subject,
      content: opts.content,
      sourceType: "comment",
      sourceId: opts.commentId,
      agentId: opts.authorId,
    });
  } catch (err) {
    logger.error({ err }, "Habitat skill signal ingestion failed (comment)");
  }
}

export function calculateStrength(signal: HabitatSkillSignal): number {
  const now = Date.now();
  const daysSinceLast = (now - new Date(signal.lastSeenAt).getTime()) / (1000 * 60 * 60 * 24);

  const frequencyScore = Math.min(signal.frequency / 5, 1.0);
  const recencyScore = Math.max(1.0 - daysSinceLast / 30, 0.0);
  const corroborationScore = Math.min(signal.corroboratingAgents / 3, 1.0);

  const totalOutcomes = signal.successfulTasks + signal.failedTasks;
  const outcomeScore = totalOutcomes > 0 ? signal.successfulTasks / totalOutcomes : 0.5;

  return (
    frequencyScore * 0.35 + recencyScore * 0.25 + corroborationScore * 0.25 + outcomeScore * 0.15
  );
}

export function reclassifyCategory(signal: HabitatSkillSignal): SkillCategory {
  if (
    signal.frequency >= 3 &&
    signal.corroboratingAgents >= 2 &&
    signal.skillCategory === "convention"
  ) {
    return "domain_knowledge";
  }
  if (signal.frequency >= 3 && signal.crossMissionCount >= 2) {
    return "pattern";
  }
  return signal.skillCategory as SkillCategory;
}

export function scoreAllSignals(habitatId: string): void {
  const signals = repo.getAllSignalsByHabitat(habitatId);
  for (const signal of signals) {
    const strength = calculateStrength(signal);
    const newCategory = reclassifyCategory(signal);

    const promotedToSkill = strength >= 0.6 ? 1 : strength < 0.2 ? 0 : signal.promotedToSkill;

    if (
      strength !== signal.strength ||
      newCategory !== signal.skillCategory ||
      promotedToSkill !== signal.promotedToSkill
    ) {
      repo.updateSignal(signal.id, {
        strength,
        skillCategory: newCategory,
        promotedToSkill,
      });
    }
  }

  recalculateCrossMissionCounts(habitatId, signals);
}

export function contributeSignal(
  habitatId: string,
  opts: {
    insight: string;
    skillCategory?: SkillCategory;
  },
): HabitatSkillSignal | null {
  try {
    const category = opts.skillCategory ?? "agent_insight";
    const subject =
      opts.insight.length > 120 ? opts.insight.slice(0, 120).trimEnd() + "..." : opts.insight;

    const normalized = normalize(subject);
    const existing = repo.findSignalByClusterKey(habitatId, normalized);

    if (existing) {
      repo.updateSignal(existing.id, {
        frequency: existing.frequency + 1,
        lastSeenAt: new Date().toISOString(),
      });
      return repo.getSignalById(existing.id);
    }

    return repo.createSignal({
      habitatId,
      clusterKey: normalized,
      skillCategory: category,
      sourceSignalType: "manual_contribution",
      sourceType: "manual",
      subject,
      summary: opts.insight,
      strength: 0.3,
    });
  } catch (err) {
    logger.error({ err }, "Habitat skill contribute failed");
    return null;
  }
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([*_[\]`~#|>\\])/g, "\\$1");
}

export function generateSkillDocument(habitatId: string): string {
  const signals = repo.getPromotedSignals(habitatId);
  const habitat = habitatRepo.getHabitatById(habitatId);
  const habitatName = habitat?.name ?? "Unknown";

  const sections: Record<string, HabitatSkillSignal[]> = {
    architecture: signals.filter((s) => s.skillCategory === "convention"),
    patterns: signals.filter((s) => s.skillCategory === "pattern"),
    pitfalls: signals.filter((s) => s.skillCategory === "pitfall"),
    domain: signals.filter((s) => s.skillCategory === "domain_knowledge"),
    insights: signals.filter((s) => s.skillCategory === "agent_insight"),
  };

  const avgStrength =
    signals.length > 0 ? signals.reduce((sum, s) => sum + s.strength, 0) / signals.length : 0;

  let md = `# Habitat Knowledge: ${habitatName}\n\n`;
  md += `Generated: ${new Date().toISOString().split("T")[0]}`;
  md += ` | Signals: ${signals.length}`;
  md += ` | Confidence: ${avgStrength > 0.7 ? "high" : avgStrength > 0.4 ? "medium" : "low"}\n\n`;

  const renderSection = (title: string, items: HabitatSkillSignal[]) => {
    if (!items.length) return;
    md += `## ${title}\n`;
    for (const s of items) {
      md += `- ${escapeMarkdown(s.summary ?? s.subject)} (x${s.frequency})\n`;
    }
    md += "\n";
  };

  renderSection("Architecture & Conventions", sections.architecture);
  renderSection("Patterns", sections.patterns);
  renderSection("Pitfalls", sections.pitfalls);
  renderSection("Domain Knowledge", sections.domain);
  renderSection("Agent Insights", sections.insights);

  return md;
}

export function regenerateSkill(habitatId: string): void {
  scoreAllSignals(habitatId);
  const content = generateSkillDocument(habitatId);

  const signals = repo.getPromotedSignals(habitatId);
  const avgStrength =
    signals.length > 0 ? signals.reduce((sum, s) => sum + s.strength, 0) / signals.length : 0;

  repo.getOrCreateSkill(habitatId);
  repo.updateSkillContent(habitatId, content, signals.length, avgStrength);
}

export async function regenerateAllSkills(): Promise<{ regenerated: number; errors: number }> {
  const habitatIds = repo.getAllSignalHabitatIds();
  let regenerated = 0;
  let errors = 0;
  for (const id of habitatIds) {
    try {
      regenerateSkill(id);
      regenerated++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } catch (err) {
      logger.error({ err, habitatId: id }, "Failed to regenerate skill");
      errors++;
    }
  }
  return { regenerated, errors };
}

export function initSkillHooks(): void {
  pulseService.onPulseCreated((pulse) => {
    ingestFromPulse({
      habitatId: pulse.habitatId,
      signalType: pulse.signalType,
      subject: pulse.subject,
      body: pulse.body,
      pulseId: pulse.id,
      fromType: pulse.fromType,
      fromId: pulse.fromId,
    });
  });

  taskLifecycle.onTaskEvent((opts) => {
    const task = taskRepo.getTaskById(opts.taskId);
    if (!task) return;

    if (opts.event === "rejected" || opts.event === "failed") {
      ingestFromTaskEvent({
        habitatId: opts.habitatId,
        eventType: opts.event,
        taskTitle: task.title,
        reason: opts.metadata?.reason as string | undefined,
        taskId: opts.taskId,
        associatedAgentId: task.assignedAgentId ?? undefined,
      });
    } else if (opts.event === "completed" || opts.event === "approved") {
      ingestFromTaskSuccess({
        habitatId: opts.habitatId,
        taskTitle: task.title,
        taskId: opts.taskId,
        associatedAgentId: task.assignedAgentId ?? undefined,
      });
    }
  });

  commentService.onCommentCreated((comment, habitatId) => {
    ingestFromComment({
      habitatId,
      taskId: comment.taskId,
      content: comment.content,
      authorType: comment.authorType,
      authorId: comment.authorId,
      commentId: comment.id,
    });
  });
}
