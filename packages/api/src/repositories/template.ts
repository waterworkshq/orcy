import { getDb } from '../db/index.js';
import { featureTemplates } from '../db/schema.js';
import { eq, or, isNull, sql, desc, asc } from 'drizzle-orm';
import type { FeatureTemplate, TaskPriority } from '../models/index.js';
import { v4 as uuid } from 'uuid';

export interface CreateTemplateInput {
  boardId: string | null;
  name: string;
  titlePattern: string;
  descriptionPattern?: string;
  priority?: TaskPriority;
  labels?: string[];
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
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
}

export function createTemplate(input: CreateTemplateInput): FeatureTemplate {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(featureTemplates).values({
    id,
    boardId: input.boardId,
    name: input.name,
    titlePattern: input.titlePattern,
    descriptionPattern: input.descriptionPattern ?? '',
    priority: input.priority ?? 'medium',
    labels: input.labels ?? [],
    requiredDomain: input.requiredDomain ?? null,
    requiredCapabilities: input.requiredCapabilities ?? [],
    isDefault: input.isDefault ?? false,
    usageCount: 0,
    createdBy: input.createdBy,
    createdAt: now,
  }).run();

  return getTemplateById(id)!;
}

export function getTemplatesByBoardId(boardId: string): FeatureTemplate[] {
  const db = getDb();
  return db
    .select()
    .from(featureTemplates)
    .where(or(eq(featureTemplates.boardId, boardId), isNull(featureTemplates.boardId)))
    .orderBy(desc(featureTemplates.isDefault), desc(featureTemplates.usageCount), asc(featureTemplates.name))
    .all() as FeatureTemplate[];
}

export function getGlobalTemplates(): FeatureTemplate[] {
  const db = getDb();
  return db
    .select()
    .from(featureTemplates)
    .where(isNull(featureTemplates.boardId))
    .orderBy(desc(featureTemplates.isDefault), desc(featureTemplates.usageCount), asc(featureTemplates.name))
    .all() as FeatureTemplate[];
}

export function getTemplateById(id: string): FeatureTemplate | null {
  const db = getDb();
  const row = db
    .select()
    .from(featureTemplates)
    .where(eq(featureTemplates.id, id))
    .get();
  return (row as FeatureTemplate) ?? null;
}

export function updateTemplate(id: string, input: UpdateTemplateInput): FeatureTemplate | null {
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

  if (Object.keys(set).length === 0) return existing;

  db.update(featureTemplates)
    .set(set)
    .where(eq(featureTemplates.id, id))
    .run();
  return getTemplateById(id);
}

export function deleteTemplate(id: string): boolean {
  const db = getDb();
  const existing = getTemplateById(id);
  if (!existing) return false;

  if (existing.isDefault) return false;

  db.delete(featureTemplates)
    .where(eq(featureTemplates.id, id))
    .run();
  return true;
}

export function incrementUsageCount(id: string): void {
  const db = getDb();
  db.update(featureTemplates)
    .set({ usageCount: sql`${featureTemplates.usageCount} + 1` })
    .where(eq(featureTemplates.id, id))
    .run();
}

export function seedGlobalTemplates(): void {
  const db = getDb();
  const existing = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(featureTemplates)
    .where(isNull(featureTemplates.boardId))
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
    db.insert(featureTemplates).values({
      id,
      boardId: null,
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
