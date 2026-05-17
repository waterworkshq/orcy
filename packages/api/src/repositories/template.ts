import { getDb } from '../db/index.js';
import { missionTemplates, missions, tasks, columns } from '../db/schema/index.js';
import { eq, or, isNull, sql, desc, asc, max } from 'drizzle-orm';
import type { MissionTemplate, TaskPriority, TaskTemplateEntry } from '../models/index.js';
import { v4 as uuid } from 'uuid';
import * as featureRepo from './feature.js';
import * as taskRepo from './task.js';

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
}

export function createTemplate(input: CreateTemplateInput): MissionTemplate {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(missionTemplates).values({
    id,
    habitatId: input.habitatId,
    name: input.name,
    titlePattern: input.titlePattern,
    descriptionPattern: input.descriptionPattern ?? '',
    priority: input.priority ?? 'medium',
    labels: input.labels ?? [],
    requiredDomain: input.requiredDomain ?? null,
    requiredCapabilities: input.requiredCapabilities ?? [],
    tasksTemplate: input.tasksTemplate ?? [],
    isDefault: input.isDefault ?? false,
    usageCount: 0,
    createdBy: input.createdBy,
    createdAt: now,
  }).run();

  return getTemplateById(id)!;
}

export function getTemplatesByBoardId(habitatId: string): MissionTemplate[] {
  const db = getDb();
  return db
    .select()
    .from(missionTemplates)
    .where(or(eq(missionTemplates.habitatId, habitatId), isNull(missionTemplates.habitatId)))
    .orderBy(desc(missionTemplates.isDefault), desc(missionTemplates.usageCount), asc(missionTemplates.name))
    .all() as MissionTemplate[];
}

export function getGlobalTemplates(): MissionTemplate[] {
  const db = getDb();
  return db
    .select()
    .from(missionTemplates)
    .where(isNull(missionTemplates.habitatId))
    .orderBy(desc(missionTemplates.isDefault), desc(missionTemplates.usageCount), asc(missionTemplates.name))
    .all() as MissionTemplate[];
}

export function getTemplateById(id: string): MissionTemplate | null {
  const db = getDb();
  const row = db
    .select()
    .from(missionTemplates)
    .where(eq(missionTemplates.id, id))
    .get();
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
  if (input.requiredCapabilities !== undefined) set.requiredCapabilities = input.requiredCapabilities;
  if (input.tasksTemplate !== undefined) set.tasksTemplate = input.tasksTemplate;

  if (Object.keys(set).length === 0) return existing;

  db.update(missionTemplates)
    .set(set)
    .where(eq(missionTemplates.id, id))
    .run();
  return getTemplateById(id);
}

export function deleteTemplate(id: string): boolean {
  const db = getDb();
  const existing = getTemplateById(id);
  if (!existing) return false;

  if (existing.isDefault) return false;

  db.delete(missionTemplates)
    .where(eq(missionTemplates.id, id))
    .run();
  return true;
}

export function incrementUsageCount(id: string): void {
  const db = getDb();
  db.update(missionTemplates)
    .set({ usageCount: sql`${missionTemplates.usageCount} + 1` })
    .where(eq(missionTemplates.id, id))
    .run();
}

export interface ApplyTemplateOverrides {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
}

export interface ApplyTemplateResult {
  feature: ReturnType<typeof featureRepo.getFeatureById> & {};
  tasks: ReturnType<typeof taskRepo.getTasksByFeatureId>;
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
  const actor = createdBy ?? 'system';
  const now = new Date().toISOString();
  const featureId = uuid();

  const columnId = db
    .select()
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
    .orderBy(columns.order)
    .all()[0]?.id;
  if (!columnId) throw new Error('Board has no columns');

  const maxOrder = db
    .select({ value: max(missions.displayOrder) })
    .from(missions)
    .where(eq(missions.columnId, columnId))
    .get();
  const displayOrder = (maxOrder?.value ?? -1) + 1;

  const createdTaskIds: string[] = [];
  const tasksTemplate = template.tasksTemplate ?? [];

  db.transaction((tx) => {
    tx.insert(missions).values({
      id: featureId,
      habitatId,
      columnId,
      title: overrides?.title ?? template.titlePattern,
      description: overrides?.description ?? template.descriptionPattern,
      acceptanceCriteria: '',
      priority: overrides?.priority ?? template.priority,
      labels: overrides?.labels ?? template.labels,
      status: 'not_started',
      displayOrder,
      dependsOn: [],
      blocks: [],
      dueAt: null,
      slaMinutes: null,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }).run();

    for (let i = 0; i < tasksTemplate.length; i++) {
      const entry = tasksTemplate[i];
      const taskId = uuid();
      const taskOrder = entry.order ?? i;

      tx.insert(tasks).values({
        id: taskId,
        missionId: featureId,
        title: entry.title,
        description: entry.description ?? '',
        priority: entry.priority ?? 'medium',
        requiredDomain: entry.requiredDomain ?? null,
        requiredCapabilities: entry.requiredCapabilities ?? [],
        status: 'pending',
        labels: [],
        order: taskOrder,
        createdBy: actor,
        estimatedMinutes: entry.estimatedMinutes ?? null,
        createdAt: now,
        updatedAt: now,
      }).run();
      createdTaskIds.push(taskId);
    }

    tx.update(missionTemplates)
      .set({ usageCount: sql`${missionTemplates.usageCount} + 1` })
      .where(eq(missionTemplates.id, templateId))
      .run();
  });

  const createdFeature = featureRepo.getFeatureById(featureId)!;
  const createdTasks = createdTaskIds
    .map(id => taskRepo.getTaskById(id))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  return {
    feature: createdFeature,
    tasks: createdTasks,
  };
}

export function seedGlobalTemplates(): void {
  const db = getDb();
  const existing = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(missionTemplates)
    .where(isNull(missionTemplates.habitatId))
    .get();
  if ((existing?.count ?? 0) > 0) return;

  const now = new Date().toISOString();
  const templates = [
    { name: 'Bug Fix', titlePattern: 'Fix: ', descriptionPattern: '## Steps to Reproduce\n...\n## Expected Behavior\n...\n## Actual Behavior\n...\n## Environment\n...', priority: 'high' as TaskPriority, labels: ['bug'] },
    { name: 'Feature', titlePattern: 'Add ', descriptionPattern: '## Summary\n...\n## Acceptance Criteria\n...\n## Technical Notes\n...', priority: 'medium' as TaskPriority, labels: ['feature'] },
    { name: 'Refactor', titlePattern: 'Refactor ', descriptionPattern: '## Current State\n...\n## Proposed Changes\n...\n## Impact\n...', priority: 'medium' as TaskPriority, labels: ['refactor'] },
    { name: 'Documentation', titlePattern: 'Document ', descriptionPattern: '## What\n...\n## Where\n...\n## Audience\n...', priority: 'low' as TaskPriority, labels: ['docs'] },
    { name: 'Test', titlePattern: 'Test ', descriptionPattern: '## What to Test\n...\n## Test Cases\n...\n## Edge Cases\n...', priority: 'medium' as TaskPriority, labels: ['test'] },
    { name: 'Security Fix', titlePattern: 'Security: ', descriptionPattern: '## Vulnerability\n...\n## CVE\n...\n## Fix Plan\n...\n## Verification\n...', priority: 'critical' as TaskPriority, labels: ['security'] },
  ];

  for (const tmpl of templates) {
    const id = uuid();
    db.insert(missionTemplates).values({
      id,
      habitatId: null,
      name: tmpl.name,
      titlePattern: tmpl.titlePattern,
      descriptionPattern: tmpl.descriptionPattern,
      priority: tmpl.priority,
      labels: tmpl.labels,
      requiredDomain: null,
      requiredCapabilities: [],
      isDefault: true,
      usageCount: 0,
      createdBy: 'system',
      createdAt: now,
    }).run();
  }
}
