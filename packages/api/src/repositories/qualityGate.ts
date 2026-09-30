import { getDb } from "../db/index.js";
import {
  qualityChecklistTemplates,
  qualityChecklistItems,
  taskQualityChecklists,
  taskQualityChecklistItems,
} from "../db/schema/index.js";
import { eq, and, exists, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { notFound } from "../errors.js";
import type {
  QualityChecklistTemplate,
  QualityChecklistItem,
  TaskQualityChecklist,
  TaskQualityChecklistItem,
  TaskQualityReport,
} from "../models/index.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

export function createTemplate(input: {
  name: string;
  description?: string;
  category: string;
  isRequired?: boolean;
  items: { title: string; description?: string; required?: boolean }[];
}): QualityChecklistTemplate {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(qualityChecklistTemplates)
      .values({
        id,
        name: input.name,
        description: input.description ?? "",
        category: input.category,
        isRequired: input.isRequired ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("qualityChecklistTemplate", err as Error, id);
  }

  input.items.forEach((item, index) => {
    try {
      db.insert(qualityChecklistItems)
        .values({
          id: uuid(),
          templateId: id,
          title: item.title,
          description: item.description ?? "",
          required: item.required ?? true,
          orderIndex: index,
          createdAt: now,
        })
        .run();
    } catch (err) {
      throw repositoryCreateError("qualityChecklistItem", err as Error, id);
    }
  });

  const template = getTemplateById(id);
  if (!template) throw repositoryNotFoundError("qualityChecklistTemplate", id);
  return template;
}

export function getTemplateById(id: string): QualityChecklistTemplate | null {
  const db = getDb();
  return (
    (db
      .select()
      .from(qualityChecklistTemplates)
      .where(eq(qualityChecklistTemplates.id, id))
      .get() as QualityChecklistTemplate) ?? null
  );
}

export function getTemplateItems(templateId: string): QualityChecklistItem[] {
  const db = getDb();
  return db
    .select()
    .from(qualityChecklistItems)
    .where(eq(qualityChecklistItems.templateId, templateId))
    .orderBy(qualityChecklistItems.orderIndex)
    .all() as QualityChecklistItem[];
}

export function listTemplates(): QualityChecklistTemplate[] {
  const db = getDb();
  return db.select().from(qualityChecklistTemplates).all() as QualityChecklistTemplate[];
}

export function createTaskChecklist(taskId: string, templateId: string): TaskQualityChecklist {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(taskQualityChecklists)
      .values({
        id,
        taskId,
        templateId,
        status: "pending",
        completedAt: null,
        completedBy: null,
        notes: "",
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("taskQualityChecklist", err as Error, id);
  }

  const items = getTemplateItems(templateId);
  for (const item of items) {
    try {
      db.insert(taskQualityChecklistItems)
        .values({
          id: uuid(),
          checklistId: id,
          itemId: item.id,
          isCompleted: false,
          completedBy: null,
          completedAt: null,
          evidenceUrl: null,
          notes: "",
        })
        .run();
    } catch (err) {
      throw repositoryCreateError("taskQualityChecklistItem", err as Error, id);
    }
  }

  const checklist = getTaskChecklistById(id);
  if (!checklist) throw repositoryNotFoundError("taskQualityChecklist", id);
  return checklist;
}

export function getTaskChecklistById(id: string): TaskQualityChecklist | null {
  const db = getDb();
  return (
    (db
      .select()
      .from(taskQualityChecklists)
      .where(eq(taskQualityChecklists.id, id))
      .get() as TaskQualityChecklist) ?? null
  );
}

export function getTaskChecklists(taskId: string): TaskQualityChecklist[] {
  const db = getDb();
  return db
    .select()
    .from(taskQualityChecklists)
    .where(eq(taskQualityChecklists.taskId, taskId))
    .all() as TaskQualityChecklist[];
}

export function getChecklistItems(checklistId: string): TaskQualityChecklistItem[] {
  const db = getDb();
  return db
    .select()
    .from(taskQualityChecklistItems)
    .where(eq(taskQualityChecklistItems.checklistId, checklistId))
    .all() as TaskQualityChecklistItem[];
}

/** Client type shared by the ordinary `getDb()` handle and a transaction's tx. */
type QualityDbClient = ReturnType<typeof getDb>;

export function updateChecklistItem(
  taskId: string,
  checklistId: string,
  checklistItemId: string,
  input: {
    isCompleted?: boolean;
    completedBy?: string | null;
    evidenceUrl?: string | null;
    notes?: string;
  },
): TaskQualityChecklistItem | null {
  const db = getDb();
  const now = new Date().toISOString();

  const updates: Partial<typeof taskQualityChecklistItems.$inferInsert> = {};
  if (input.isCompleted !== undefined) {
    updates.isCompleted = input.isCompleted;
    updates.completedBy = input.isCompleted ? (input.completedBy ?? null) : null;
    updates.completedAt = input.isCompleted ? now : null;
  }
  if (input.evidenceUrl !== undefined) updates.evidenceUrl = input.evidenceUrl;
  if (input.notes !== undefined) updates.notes = input.notes;

  // Writer-reserved (immediate) atomic aggregate: the item UPDATE and the same
  // owned checklist's status recalculation commit together or not at all.
  // Request-time Task/Mission/Habitat admission is NOT part of this fence; the
  // final SQL predicates bind item → instance checklist → URL Task.
  return db.transaction(
    (tx) => {
      const scoped = tx
        .select({ id: taskQualityChecklistItems.id })
        .from(taskQualityChecklistItems)
        .innerJoin(
          taskQualityChecklists,
          eq(taskQualityChecklistItems.checklistId, taskQualityChecklists.id),
        )
        .where(
          and(
            eq(taskQualityChecklistItems.id, checklistItemId),
            eq(taskQualityChecklistItems.checklistId, checklistId),
            eq(taskQualityChecklists.taskId, taskId),
          ),
        )
        .get();
      if (!scoped) return null;

      let updated: TaskQualityChecklistItem | undefined;
      try {
        const rows = tx
          .update(taskQualityChecklistItems)
          .set(updates)
          .where(
            and(
              eq(taskQualityChecklistItems.id, checklistItemId),
              eq(taskQualityChecklistItems.checklistId, checklistId),
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(taskQualityChecklists)
                  .where(
                    and(
                      eq(taskQualityChecklists.id, checklistId),
                      eq(taskQualityChecklists.taskId, taskId),
                    ),
                  ),
              ),
            ),
          )
          .returning()
          .all() as TaskQualityChecklistItem[];
        updated = rows[0];
      } catch (err) {
        throw repositoryUpdateError("taskQualityChecklistItem", err as Error, checklistItemId);
      }
      // Zero matched rows after a positive lookup (the row was reparented or
      // removed between the scoped read and this statement): no effects.
      if (!updated) return null;

      recalcChecklistStatusWithClient(tx, taskId, checklistId);
      return updated;
    },
    { behavior: "immediate" },
  );
}

/**
 * Derives and persists the instance checklist's status on the supplied client
 * (the ordinary client for the public primitive, the aggregate's tx inside
 * `updateChecklistItem`). Every read/write is scoped to the exact
 * checklist → URL Task pair; a missing owned checklist or a zero-row scoped
 * status UPDATE throws a generic 404 so an enclosing transaction rolls back —
 * never a synthetic "pending" and never a committed item without its status.
 */
function recalcChecklistStatusWithClient(
  client: QualityDbClient,
  taskId: string,
  checklistId: string,
): string {
  const items = client
    .select()
    .from(taskQualityChecklistItems)
    .where(eq(taskQualityChecklistItems.checklistId, checklistId))
    .all() as TaskQualityChecklistItem[];
  const checklistRow = client
    .select()
    .from(taskQualityChecklists)
    .where(
      and(eq(taskQualityChecklists.id, checklistId), eq(taskQualityChecklists.taskId, taskId)),
    )
    .get() as TaskQualityChecklist | undefined;
  if (!checklistRow) {
    throw notFound("Quality checklist not found");
  }

  const template = checklistRow.templateId
    ? ((client
        .select()
        .from(qualityChecklistTemplates)
        .where(eq(qualityChecklistTemplates.id, checklistRow.templateId))
        .get() as QualityChecklistTemplate | undefined) ?? null)
    : null;
  const requiredItems = template?.isRequired
    ? items.filter((i) => {
        const templateItem = client
          .select()
          .from(qualityChecklistItems)
          .where(eq(qualityChecklistItems.id, i.itemId))
          .get() as QualityChecklistItem | undefined;
        return templateItem?.required ?? true;
      })
    : items;

  const completedRequired = requiredItems.filter((i) => i.isCompleted).length;
  const totalRequired = requiredItems.length;

  let status = "pending";
  if (completedRequired === totalRequired && totalRequired > 0) {
    status = "passed";
  } else if (completedRequired > 0) {
    status = "in_progress";
  }

  let statusRows: TaskQualityChecklist[];
  try {
    statusRows = client
      .update(taskQualityChecklists)
      .set({
        status,
        completedAt: status === "passed" ? new Date().toISOString() : null,
      })
      .where(
        and(eq(taskQualityChecklists.id, checklistId), eq(taskQualityChecklists.taskId, taskId)),
      )
      .returning()
      .all() as TaskQualityChecklist[];
  } catch (err) {
    throw repositoryUpdateError("taskQualityChecklist", err as Error, checklistId);
  }
  if (statusRows.length === 0) {
    throw notFound("Quality checklist not found");
  }

  return status;
}

export function updateChecklistStatus(taskId: string, checklistId: string): string {
  return recalcChecklistStatusWithClient(getDb(), taskId, checklistId);
}
export function getQualityReport(taskId: string): TaskQualityReport {
  const db = getDb();
  const checklists = getTaskChecklists(taskId);

  const reportChecklists: TaskQualityReport["checklists"] = [];
  const missingRequirements: TaskQualityReport["missingRequirements"] = [];
  let allPassed = true;

  for (const checklist of checklists) {
    const template = checklist.templateId ? getTemplateById(checklist.templateId) : null;
    const items = getChecklistItems(checklist.id);

    const reportItems = items.map((item) => {
      const templateItem = db
        .select()
        .from(qualityChecklistItems)
        .where(eq(qualityChecklistItems.id, item.itemId))
        .get();
      return {
        id: item.id,
        title: templateItem?.title ?? "Unknown",
        required: templateItem?.required ?? true,
        isCompleted: item.isCompleted,
        completedBy: item.completedBy,
        completedAt: item.completedAt,
        evidenceUrl: item.evidenceUrl,
        notes: item.notes,
      };
    });

    const completed = items.filter((i) => i.isCompleted).length;
    const requiredMissing = reportItems.filter((i) => i.required && !i.isCompleted);

    if (requiredMissing.length > 0 && template?.isRequired) {
      allPassed = false;
      missingRequirements.push({
        category: template?.category ?? "unknown",
        missingItems: requiredMissing.map((i) => i.title),
      });
    }

    reportChecklists.push({
      id: checklist.id,
      templateId: checklist.templateId ?? "",
      templateName: template?.name ?? "Unknown",
      category: template?.category ?? "unknown",
      required: template?.isRequired ?? true,
      status: checklist.status,
      progress: { total: items.length, completed },
      items: reportItems,
    });
  }

  return {
    taskId,
    overallStatus: allPassed ? "passed" : "blocked",
    canApprove: allPassed,
    checklists: reportChecklists,
    missingRequirements,
  };
}

export function validateQualityGates(taskId: string): {
  passed: boolean;
  failures: { category: string; missingItems: string[] }[];
} {
  const report = getQualityReport(taskId);

  if (report.missingRequirements.length === 0) {
    return { passed: true, failures: [] };
  }

  return {
    passed: false,
    failures: report.missingRequirements,
  };
}

export function ensureTaskChecklists(taskId: string): void {
  const db = getDb();
  const templates = db
    .select()
    .from(qualityChecklistTemplates)
    .where(eq(qualityChecklistTemplates.isRequired, true))
    .all() as QualityChecklistTemplate[];

  for (const template of templates) {
    const existing = db
      .select()
      .from(taskQualityChecklists)
      .where(
        and(
          eq(taskQualityChecklists.taskId, taskId),
          eq(taskQualityChecklists.templateId, template.id),
        ),
      )
      .get();

    if (!existing) {
      createTaskChecklist(taskId, template.id);
    }
  }
}

export function seedDefaultTemplates(): void {
  const existing = listTemplates();
  if (existing.length > 0) return;

  createTemplate({
    name: "Code Review",
    category: "code_review",
    isRequired: true,
    items: [
      {
        title: "Code follows project conventions",
        required: true,
        description: "Code style, naming conventions, file structure",
      },
      { title: "No linting errors", required: true, description: "ESLint/Prettier checks pass" },
      {
        title: "TypeScript types are correct",
        required: true,
        description: "No type errors, proper type definitions",
      },
      {
        title: "Code is documented",
        required: false,
        description: "JSDoc comments for public APIs",
      },
    ],
  });

  createTemplate({
    name: "Testing",
    category: "testing",
    isRequired: true,
    items: [
      {
        title: "Unit tests added/updated",
        required: true,
        description: "New code has unit test coverage",
      },
      { title: "All tests pass", required: true, description: "npm test passes without errors" },
      {
        title: "Test coverage maintained",
        required: true,
        description: "Coverage does not decrease",
      },
      {
        title: "Integration tests updated",
        required: false,
        description: "API integration tests reflect changes",
      },
    ],
  });

  createTemplate({
    name: "Documentation",
    category: "documentation",
    isRequired: true,
    items: [
      {
        title: "README updated",
        required: false,
        description: "Project README reflects changes if needed",
      },
      {
        title: "API documentation updated",
        required: true,
        description: "API endpoints documented",
      },
      { title: "Changelog entry", required: false, description: "CHANGELOG.md updated" },
    ],
  });

  createTemplate({
    name: "Deployment",
    category: "deployment",
    isRequired: true,
    items: [
      {
        title: "Build succeeds",
        required: true,
        description: "npm run build completes successfully",
      },
      {
        title: "Environment variables documented",
        required: false,
        description: "New env vars are documented",
      },
      {
        title: "Rollback plan exists",
        required: false,
        description: "Can revert changes if needed",
      },
    ],
  });
}
