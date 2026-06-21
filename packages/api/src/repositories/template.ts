import { getDb } from "../db/index.js";
import {
  missionTemplates,
  missions,
  tasks,
  columns,
  workflows,
  taskWorkflowGates,
} from "../db/schema/index.js";
import { eq, or, and, isNull, sql, desc, asc, max } from "drizzle-orm";
import type {
  MissionTemplate,
  TaskPriority,
  TaskTemplateEntry,
  WorkflowTemplateDefinition,
  WorkflowFailureHandlerConfig,
  JoinMode,
} from "../models/index.js";
import { v4 as uuid } from "uuid";
import * as missionRepo from "./feature.js";
import * as taskRepo from "./task.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
  repositoryTransactionError,
} from "../errors/repository.js";

export interface CreateTemplateInput {
  habitatId: string | null;
  name: string;
  titlePattern: string;
  descriptionPattern?: string;
  priority?: TaskPriority;
  labels?: string[];
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  tasksTemplate?: TaskTemplateEntry[];
  workflowTemplate?: WorkflowTemplateDefinition | null;
  isDefault?: boolean;
  createdBy: string;
}

export interface UpdateTemplateInput {
  name?: string;
  titlePattern?: string;
  descriptionPattern?: string;
  priority?: TaskPriority;
  labels?: string[];
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  tasksTemplate?: TaskTemplateEntry[];
  workflowTemplate?: WorkflowTemplateDefinition | null;
}

export function createTemplate(input: CreateTemplateInput): MissionTemplate {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(missionTemplates)
      .values({
        id,
        habitatId: input.habitatId,
        name: input.name,
        titlePattern: input.titlePattern,
        descriptionPattern: input.descriptionPattern ?? "",
        priority: input.priority ?? "medium",
        labels: input.labels ?? [],
        requiredDomain: input.requiredDomain ?? null,
        requiredCapabilities: input.requiredCapabilities ?? [],
        tasksTemplate: input.tasksTemplate ?? [],
        workflowTemplate: input.workflowTemplate ?? null,
        isDefault: input.isDefault ?? false,
        usageCount: 0,
        createdBy: input.createdBy,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("template", err as Error, id);
  }

  const template = getTemplateById(id);
  if (!template) throw repositoryNotFoundError("template", id);
  return template;
}

export function getTemplatesByHabitatId(habitatId: string): MissionTemplate[] {
  const db = getDb();
  return db
    .select()
    .from(missionTemplates)
    .where(or(eq(missionTemplates.habitatId, habitatId), isNull(missionTemplates.habitatId)))
    .orderBy(
      desc(missionTemplates.isDefault),
      desc(missionTemplates.usageCount),
      asc(missionTemplates.name),
    )
    .all() as MissionTemplate[];
}

export function getGlobalTemplates(): MissionTemplate[] {
  const db = getDb();
  return db
    .select()
    .from(missionTemplates)
    .where(isNull(missionTemplates.habitatId))
    .orderBy(
      desc(missionTemplates.isDefault),
      desc(missionTemplates.usageCount),
      asc(missionTemplates.name),
    )
    .all() as MissionTemplate[];
}

export function getTemplateById(id: string): MissionTemplate | null {
  const db = getDb();
  const row = db.select().from(missionTemplates).where(eq(missionTemplates.id, id)).get();
  return (row as MissionTemplate) ?? null;
}

export function updateTemplate(id: string, input: UpdateTemplateInput): MissionTemplate | null {
  const db = getDb();

  const existing = getTemplateById(id);
  if (!existing) return null;

  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.titlePattern !== undefined) set.titlePattern = input.titlePattern;
  if (input.descriptionPattern !== undefined) set.descriptionPattern = input.descriptionPattern;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.labels !== undefined) set.labels = input.labels;
  if (input.requiredDomain !== undefined) set.requiredDomain = input.requiredDomain;
  if (input.requiredCapabilities !== undefined)
    set.requiredCapabilities = input.requiredCapabilities;
  if (input.tasksTemplate !== undefined) set.tasksTemplate = input.tasksTemplate;
  if (input.workflowTemplate !== undefined) set.workflowTemplate = input.workflowTemplate;

  if (Object.keys(set).length === 0) return existing;

  try {
    db.update(missionTemplates).set(set).where(eq(missionTemplates.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("template", err as Error, id);
  }
  return getTemplateById(id);
}

export function deleteTemplate(id: string): boolean {
  const db = getDb();
  const existing = getTemplateById(id);
  if (!existing) return false;

  if (existing.isDefault) return false;

  try {
    db.delete(missionTemplates).where(eq(missionTemplates.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("template", err as Error, id);
  }
  return true;
}

export function incrementUsageCount(id: string): void {
  const db = getDb();
  try {
    db.update(missionTemplates)
      .set({ usageCount: sql`${missionTemplates.usageCount} + 1` })
      .where(eq(missionTemplates.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("template", err as Error, id);
  }
}

export interface ApplyTemplateOverrides {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
  /** Caller-provided values for workflow template variables. */
  variables?: Record<string, string>;
}

export interface ApplyTemplateResult {
  mission: ReturnType<typeof missionRepo.getMissionById> & {};
  tasks: ReturnType<typeof taskRepo.getTasksByMissionId>;
  /** The instantiated workflow row, or null when the template has no workflow definition. */
  workflow: typeof workflows.$inferSelect | null;
}

type DbHandle = ReturnType<typeof getDb>;

const TERMINAL_TASK_STATUSES = ["done", "approved", "failed", "rejected"] as const;

/** Error thrown when workflow template validation fails during applyTemplate; surfaces with a clear message instead of being wrapped as a transaction error. */
export class TemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateValidationError";
  }
}

interface InstantiateWorkflowOpts {
  workflowTemplate: WorkflowTemplateDefinition;
  tasksTemplate: TaskTemplateEntry[];
  createdTaskIds: string[];
  missionId: string;
  habitatId: string;
  callerVariables: Record<string, string>;
  actor: string;
  now: string;
}

/** Replaces `{{key}}` patterns with resolved variable values, leaving undeclared runtime tokens (e.g. `{{failedTaskTitle}}`) as-is. */
function substituteTemplateVariables(
  text: string | undefined | null,
  resolvedVars: Record<string, string>,
): string | undefined {
  if (!text) return text ?? undefined;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, varKey: string) => {
    return varKey in resolvedVars ? resolvedVars[varKey] : match;
  });
}

/** Returns a copy of the failure handler with variable substitution applied to the recovery task template text. */
function substituteFailureHandler(
  handler: WorkflowFailureHandlerConfig,
  substitute: (text: string | undefined | null) => string | undefined,
): WorkflowFailureHandlerConfig {
  const rtt = handler.recoveryTaskTemplate;
  return {
    ...handler,
    recoveryTaskTemplate: {
      ...rtt,
      title: substitute(rtt.title) ?? rtt.title,
      description:
        rtt.description !== undefined
          ? (substitute(rtt.description) ?? rtt.description)
          : rtt.description,
    },
  };
}

/** Instantiates a workflow DAG (workflow row + gate rows) from a template definition inside an applyTemplate transaction. */
function instantiateWorkflow(tx: DbHandle, opts: InstantiateWorkflowOpts): string {
  const {
    workflowTemplate: wfDef,
    tasksTemplate,
    createdTaskIds,
    missionId,
    habitatId,
    callerVariables,
    actor,
    now,
  } = opts;

  const keyToTaskId = new Map<string, string>();
  const keyToEntry = new Map<string, TaskTemplateEntry>();
  for (let i = 0; i < tasksTemplate.length; i++) {
    const entry = tasksTemplate[i];
    const tid = createdTaskIds[i];
    const key = entry.key ?? `task_${i + 1}`;
    if (keyToTaskId.has(key)) {
      throw new TemplateValidationError(`Duplicate task key "${key}" in template`);
    }
    keyToTaskId.set(key, tid);
    keyToEntry.set(key, entry);
  }

  const resolvedVars: Record<string, string> = {};
  for (const vdef of wfDef.variables ?? []) {
    const callerVal = callerVariables[vdef.key];
    const defaultVal = vdef.default;
    if (callerVal !== undefined) {
      resolvedVars[vdef.key] = callerVal;
    } else if (defaultVal !== undefined) {
      resolvedVars[vdef.key] = defaultVal;
    } else if (vdef.required) {
      throw new TemplateValidationError(
        `Required template variable "${vdef.key}" was not provided`,
      );
    }
  }

  const substitute = (text: string | undefined | null): string | undefined =>
    substituteTemplateVariables(text, resolvedVars);

  for (let i = 0; i < tasksTemplate.length; i++) {
    const entry = tasksTemplate[i];
    const tid = createdTaskIds[i];
    const newTitle = substitute(entry.title);
    const newDesc = entry.description !== undefined ? substitute(entry.description) : undefined;
    if (newTitle !== entry.title || newDesc !== entry.description) {
      tx.update(tasks)
        .set({ title: newTitle ?? entry.title, description: newDesc ?? entry.description ?? "" })
        .where(eq(tasks.id, tid))
        .run();
    }
  }

  const resolvedJoinSpecs: Record<string, { mode: JoinMode; n?: number }> = {};
  for (const [taskKey, spec] of Object.entries(wfDef.joinSpecs ?? {})) {
    const tid = keyToTaskId.get(taskKey);
    if (!tid) {
      throw new TemplateValidationError(`Join spec references unknown task key "${taskKey}"`);
    }
    resolvedJoinSpecs[tid] = spec;
  }

  let resolvedFailureHandler: WorkflowFailureHandlerConfig | null = wfDef.failureHandler ?? null;
  if (resolvedFailureHandler) {
    resolvedFailureHandler = substituteFailureHandler(resolvedFailureHandler, substitute);
  }

  const workflowId = uuid();
  tx.insert(workflows)
    .values({
      id: workflowId,
      missionId,
      habitatId,
      resolvedVariables: resolvedVars,
      joinSpecs: resolvedJoinSpecs,
      failureHandler: resolvedFailureHandler,
      status: "active",
      createdBy: actor,
    })
    .run();

  for (const gate of wfDef.gates) {
    const upstreamTaskId = keyToTaskId.get(gate.upstreamTaskKey);
    const downstreamTaskId = keyToTaskId.get(gate.downstreamTaskKey);
    if (!upstreamTaskId) {
      throw new TemplateValidationError(
        `Gate references unknown upstream task key "${gate.upstreamTaskKey}"`,
      );
    }
    if (!downstreamTaskId) {
      throw new TemplateValidationError(
        `Gate references unknown downstream task key "${gate.downstreamTaskKey}"`,
      );
    }

    let matchConfig = gate.matchConfig as Record<string, unknown> | undefined;
    if (matchConfig) {
      matchConfig = { ...matchConfig };
      if (typeof matchConfig.subjectContains === "string") {
        const substituted = substitute(matchConfig.subjectContains);
        if (substituted !== undefined) matchConfig.subjectContains = substituted;
      }
    }

    const upstreamEntry = keyToEntry.get(gate.upstreamTaskKey);
    if (upstreamEntry && upstreamEntry.failureHandlerOverride !== undefined) {
      const override = upstreamEntry.failureHandlerOverride
        ? substituteFailureHandler(upstreamEntry.failureHandlerOverride, substitute)
        : null;
      matchConfig = { ...matchConfig, failureHandlerOverride: override };
    }

    const upstreamTaskRow = tx
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, upstreamTaskId))
      .get();
    const isPreSatisfied =
      !!upstreamTaskRow &&
      (TERMINAL_TASK_STATUSES as readonly string[]).includes(upstreamTaskRow.status);

    tx.insert(taskWorkflowGates)
      .values({
        id: uuid(),
        workflowId,
        missionId,
        habitatId,
        upstreamTaskId,
        downstreamTaskId,
        gateType: gate.gateType,
        matchConfig: matchConfig ?? null,
        condition: gate.condition ?? null,
        satisfied: isPreSatisfied,
        satisfiedAt: isPreSatisfied ? now : null,
        satisfiedByEventId: isPreSatisfied ? `pre_satisfied_at_attach:${now}` : null,
        recoveryDepth: 0,
      })
      .run();
  }

  return workflowId;
}

export function applyTemplate(
  templateId: string,
  habitatId: string,
  overrides?: ApplyTemplateOverrides,
  createdBy?: string,
): ApplyTemplateResult | null {
  const template = getTemplateById(templateId);
  if (!template) return null;

  const db = getDb();
  const actor = createdBy ?? "system";
  const now = new Date().toISOString();
  const missionId = uuid();

  const columnId = db
    .select()
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
    .orderBy(columns.order)
    .all()[0]?.id;
  if (!columnId) throw new Error("Habitat has no columns");

  const maxOrder = db
    .select({ value: max(missions.displayOrder) })
    .from(missions)
    .where(eq(missions.columnId, columnId))
    .get();
  const displayOrder = (maxOrder?.value ?? -1) + 1;

  const createdTaskIds: string[] = [];
  const tasksTemplate = template.tasksTemplate ?? [];
  let createdWorkflowId: string | null = null;

  try {
    db.transaction((tx) => {
      tx.insert(missions)
        .values({
          id: missionId,
          habitatId,
          columnId,
          title: overrides?.title ?? template.titlePattern,
          description: overrides?.description ?? template.descriptionPattern,
          acceptanceCriteria: "",
          priority: overrides?.priority ?? template.priority,
          labels: overrides?.labels ?? template.labels,
          status: "not_started",
          displayOrder,
          dependsOn: [],
          blocks: [],
          dueAt: null,
          slaMinutes: null,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
          version: 1,
        })
        .run();

      for (let i = 0; i < tasksTemplate.length; i++) {
        const entry = tasksTemplate[i];
        const taskId = uuid();
        const taskOrder = entry.order ?? i;

        tx.insert(tasks)
          .values({
            id: taskId,
            missionId: missionId,
            title: entry.title,
            description: entry.description ?? "",
            priority: entry.priority ?? "medium",
            requiredDomain: entry.requiredDomain ?? null,
            requiredCapabilities: entry.requiredCapabilities ?? [],
            status: entry.initialStatus ?? "pending",
            labels: [],
            order: taskOrder,
            createdBy: actor,
            estimatedMinutes: entry.estimatedMinutes ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        createdTaskIds.push(taskId);
      }

      if (template.workflowTemplate) {
        createdWorkflowId = instantiateWorkflow(tx, {
          workflowTemplate: template.workflowTemplate,
          tasksTemplate,
          createdTaskIds,
          missionId,
          habitatId,
          callerVariables: overrides?.variables ?? {},
          actor,
          now,
        });
      }

      tx.update(missionTemplates)
        .set({ usageCount: sql`${missionTemplates.usageCount} + 1` })
        .where(eq(missionTemplates.id, templateId))
        .run();
    });
  } catch (err) {
    if (err instanceof TemplateValidationError) throw err;
    throw repositoryTransactionError("template", err as Error, templateId);
  }

  const createdMission = missionRepo.getMissionById(missionId)!;
  const createdTasks = createdTaskIds
    .map((id) => taskRepo.getTaskById(id))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  const createdWorkflow = createdWorkflowId
    ? (db.select().from(workflows).where(eq(workflows.id, createdWorkflowId)).get() ?? null)
    : null;

  return {
    mission: createdMission,
    tasks: createdTasks,
    workflow: createdWorkflow,
  };
}

export function seedGlobalTemplates(): void {
  const db = getDb();
  const now = new Date().toISOString();

  const templates: Array<{
    name: string;
    titlePattern: string;
    descriptionPattern: string;
    priority: TaskPriority;
    labels: string[];
    tasksTemplate?: TaskTemplateEntry[];
    workflowTemplate?: WorkflowTemplateDefinition;
  }> = [
    {
      name: "Bug Fix",
      titlePattern: "Fix: ",
      descriptionPattern:
        "## Steps to Reproduce\n...\n## Expected Behavior\n...\n## Actual Behavior\n...\n## Environment\n...",
      priority: "high",
      labels: ["bug"],
    },
    {
      name: "Feature",
      titlePattern: "Add ",
      descriptionPattern: "## Summary\n...\n## Acceptance Criteria\n...\n## Technical Notes\n...",
      priority: "medium",
      labels: ["feature"],
    },
    {
      name: "Refactor",
      titlePattern: "Refactor ",
      descriptionPattern: "## Current State\n...\n## Proposed Changes\n...\n## Impact\n...",
      priority: "medium",
      labels: ["refactor"],
    },
    {
      name: "Documentation",
      titlePattern: "Document ",
      descriptionPattern: "## What\n...\n## Where\n...\n## Audience\n...",
      priority: "low",
      labels: ["docs"],
    },
    {
      name: "Test",
      titlePattern: "Test ",
      descriptionPattern: "## What to Test\n...\n## Test Cases\n...\n## Edge Cases\n...",
      priority: "medium",
      labels: ["test"],
    },
    {
      name: "Security Fix",
      titlePattern: "Security: ",
      descriptionPattern:
        "## Vulnerability\n...\n## CVE\n...\n## Fix Plan\n...\n## Verification\n...",
      priority: "critical",
      labels: ["security"],
    },
    {
      name: "Build-Test-Review-Deploy",
      titlePattern: "Deliver: {{feature_name}}",
      descriptionPattern:
        "## Feature\n{{feature_name}}\n## Pipeline\nSequential build → test → review → deploy.",
      priority: "medium",
      labels: ["workflow", "pipeline"],
      tasksTemplate: [
        {
          key: "build",
          title: "Build: {{feature_name}}",
          description: "Implement the {{feature_name}} feature.",
          order: 0,
          requiredDomain: "backend",
          requiredCapabilities: ["implementation"],
        },
        {
          key: "test",
          title: "Test: {{feature_name}}",
          description: "Write and run tests for {{feature_name}}.",
          order: 1,
          requiredDomain: "qa",
          requiredCapabilities: ["testing"],
        },
        {
          key: "review",
          title: "Review: {{feature_name}}",
          description: "Code review of the {{feature_name}} implementation.",
          order: 2,
          requiredDomain: "review",
          requiredCapabilities: ["code-review"],
        },
        {
          key: "deploy",
          title: "Deploy: {{feature_name}}",
          description: "Deploy {{feature_name}} to production.",
          order: 3,
          requiredDomain: "deploy",
          requiredCapabilities: ["deployment"],
        },
      ],
      workflowTemplate: {
        gates: [
          { upstreamTaskKey: "build", downstreamTaskKey: "test", gateType: "on_approve" },
          { upstreamTaskKey: "test", downstreamTaskKey: "review", gateType: "on_approve" },
          { upstreamTaskKey: "review", downstreamTaskKey: "deploy", gateType: "on_approve" },
        ],
        failureHandler: {
          recoveryTaskTemplate: {
            title: "Investigate {{failedTaskTitle}} failure",
            description: "Diagnose and fix the failure in the build-test-review-deploy pipeline.",
          },
        },
        variables: [
          { key: "feature_name", description: "Name of the feature being built", required: true },
        ],
      },
    },
    {
      name: "Parallel Investigation",
      titlePattern: "Investigate: {{area}}",
      descriptionPattern:
        "## Area\n{{area}}\n## Approach\nFan-out investigation across options, fan-in to a recommendation.",
      priority: "medium",
      labels: ["workflow", "investigation"],
      tasksTemplate: [
        {
          key: "scout",
          title: "Scout: {{area}} architecture",
          description: "Survey the {{area}} landscape and identify options.",
          order: 0,
          requiredCapabilities: ["investigation"],
        },
        {
          key: "inv1",
          title: "Investigate option A for {{area}}",
          description: "Deep-dive into option A for {{area}}.",
          order: 1,
          requiredCapabilities: ["investigation"],
        },
        {
          key: "inv2",
          title: "Investigate option B for {{area}}",
          description: "Deep-dive into option B for {{area}}.",
          order: 2,
          requiredCapabilities: ["investigation"],
        },
        {
          key: "inv3",
          title: "Investigate option C for {{area}}",
          description: "Deep-dive into option C for {{area}}.",
          order: 3,
          requiredCapabilities: ["investigation"],
        },
        {
          key: "report",
          title: "Report: Recommend approach for {{area}}",
          description: "Synthesize findings and recommend an approach for {{area}}.",
          order: 4,
          requiredCapabilities: ["synthesis"],
        },
      ],
      workflowTemplate: {
        gates: [
          { upstreamTaskKey: "scout", downstreamTaskKey: "inv1", gateType: "on_complete" },
          { upstreamTaskKey: "scout", downstreamTaskKey: "inv2", gateType: "on_complete" },
          { upstreamTaskKey: "scout", downstreamTaskKey: "inv3", gateType: "on_complete" },
          { upstreamTaskKey: "inv1", downstreamTaskKey: "report", gateType: "on_complete" },
          { upstreamTaskKey: "inv2", downstreamTaskKey: "report", gateType: "on_complete" },
          { upstreamTaskKey: "inv3", downstreamTaskKey: "report", gateType: "on_complete" },
        ],
        joinSpecs: {
          report: { mode: "any_of" },
        },
        variables: [
          { key: "area", description: "Architecture area to investigate", required: true },
        ],
      },
    },
  ];

  for (const tmpl of templates) {
    const existing = db
      .select({ id: missionTemplates.id })
      .from(missionTemplates)
      .where(and(isNull(missionTemplates.habitatId), eq(missionTemplates.name, tmpl.name)))
      .get();
    if (existing) continue;

    const id = uuid();
    try {
      db.insert(missionTemplates)
        .values({
          id,
          habitatId: null,
          name: tmpl.name,
          titlePattern: tmpl.titlePattern,
          descriptionPattern: tmpl.descriptionPattern,
          priority: tmpl.priority,
          labels: tmpl.labels,
          requiredDomain: null,
          requiredCapabilities: [],
          tasksTemplate: tmpl.tasksTemplate ?? [],
          workflowTemplate: tmpl.workflowTemplate ?? null,
          isDefault: true,
          usageCount: 0,
          createdBy: "system",
          createdAt: now,
        })
        .run();
    } catch (err) {
      throw repositoryCreateError("template", err as Error, id);
    }
  }
}
