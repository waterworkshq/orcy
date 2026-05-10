import { getDb } from '../db/index.js';
import { tasks, taskDependencies, features, featureDependencies } from '../db/schema.js';
import { eq, and, or, not, lt, gt, isNull, isNotNull, sql, count, notInArray, notExists, inArray, max, asc, desc, like } from 'drizzle-orm';
import type { Task, TaskStatus, TaskPriority, Artifact, RetryPolicy } from '../models/index.js';
import { v4 as uuid } from 'uuid';

export interface CreateTaskInput {
  featureId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: TaskPriority;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  createdBy: string;
  order?: number;
  estimatedMinutes?: number | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  status?: TaskStatus;
  result?: string | null;
  artifacts?: Artifact[];
  rejectedCount?: number;
  rejectionReason?: string | null;
  delegatedToAgentId?: string | null;
  assignedAgentId?: string | null;
  estimatedMinutes?: number | null;
  retryPolicy?: RetryPolicy | null;
  retryCount?: number;
  nextRetryAt?: string | null;
  completedAt?: string | null;
  claimedAt?: string | null;
  startedAt?: string | null;
  submittedAt?: string | null;
  actualMinutes?: number | null;
  cycleTimeMinutes?: number | null;
  leadTimeMinutes?: number | null;
  estimationAccuracy?: number | null;
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  let order = input.order;
  if (order === undefined) {
    const result = db
      .select({ maxOrder: max(tasks.order) })
      .from(tasks)
      .where(eq(tasks.featureId, input.featureId))
      .get();
    order = (result?.maxOrder ?? -1) + 1;
  }

  db.insert(tasks).values({
    id,
    featureId: input.featureId,
    title: input.title,
    description: input.description ?? '',
    priority: input.priority ?? 'medium',
    requiredDomain: input.requiredDomain ?? null,
    requiredCapabilities: input.requiredCapabilities ?? [],
    status: 'pending',
    labels: input.labels ?? [],
    order,
    createdBy: input.createdBy,
    estimatedMinutes: input.estimatedMinutes ?? null,
    createdAt: now,
    updatedAt: now,
  }).run();

  return getTaskById(id)!;
}

export function getTaskByTitle(featureId: string, title: string): Task | null {
  const db = getDb();
  return db.select().from(tasks).where(and(eq(tasks.featureId, featureId), eq(tasks.title, title))).get() ?? null;
}

export function getTaskById(id: string): Task | null {
  const db = getDb();
  const normalized = id.startsWith('feat-') ? id.slice(5) : id;
  return db.select().from(tasks).where(eq(tasks.id, normalized)).get() as Task ?? null;
}

export function getTasksByFeatureId(
  featureId: string,
  filters?: { status?: TaskStatus; priority?: TaskPriority; limit?: number; offset?: number }
): Task[] {
  const db = getDb();

  const ids = featureId.startsWith('feat-')
    ? [featureId]
    : [featureId, `feat-${featureId}`];

  const conditions = [inArray(tasks.featureId, ids)];
  if (filters?.status) conditions.push(eq(tasks.status, filters.status));
  if (filters?.priority) conditions.push(eq(tasks.priority, filters.priority));

  const where = and(...conditions);

  const query = db.select().from(tasks).where(where).orderBy(asc(tasks.order), asc(tasks.createdAt));
  return filters?.limit !== undefined
    ? query.limit(filters.limit).offset(filters?.offset ?? 0).all() as Task[]
    : query.all() as Task[];
}

export function getTasksByFeatureIds(featureIds: string[]): Task[] {
  if (featureIds.length === 0) return [];
  const db = getDb();
  const expanded = featureIds.flatMap(id =>
    id.startsWith('feat-') ? [id] : [id, `feat-${id}`]
  );
  return db
    .select()
    .from(tasks)
    .where(inArray(tasks.featureId, expanded))
    .orderBy(asc(tasks.order), asc(tasks.createdAt))
    .all() as Task[];
}

export function getAvailableTasksForAgent(
  boardId: string,
  agentDomain: string,
  filters?: { status?: TaskStatus; priority?: TaskPriority; limit?: number }
): Task[] {
  const db = getDb();

  const statusCondition = filters?.status
    ? eq(tasks.status, filters.status)
    : or(eq(tasks.status, 'pending'), eq(tasks.status, 'claimed'), eq(tasks.status, 'in_progress'))!;

  const domainCondition = or(isNull(tasks.requiredDomain), eq(tasks.requiredDomain, agentDomain))!;

  const boardFeatures = db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.boardId, boardId))
    .all();
  const boardFeatureIds = boardFeatures.map(f => f.id);

  if (boardFeatureIds.length === 0) return [];

  const unmetDeps = db
    .select()
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(
      and(
        eq(taskDependencies.taskId, tasks.id),
        notInArray(tasks.status, ['done', 'approved'])
      )
    );

  const unmetFeatureDeps = db
    .select()
    .from(featureDependencies)
    .innerJoin(features, eq(featureDependencies.dependsOnId, features.id))
    .where(
      and(
        eq(featureDependencies.featureId, features.id),
        notInArray(features.status, ['done'])
      )
    );

  const eligibleFeatureIds = boardFeatureIds.filter(fid => {
    const deps = db
      .select()
      .from(featureDependencies)
      .innerJoin(features, eq(featureDependencies.dependsOnId, features.id))
      .where(
        and(
          eq(featureDependencies.featureId, fid),
          notInArray(features.status, ['done'])
        )
      )
      .all();
    return deps.length === 0;
  });

  if (eligibleFeatureIds.length === 0) return [];

  const conditions = [
    inArray(tasks.featureId, eligibleFeatureIds),
    statusCondition,
    domainCondition,
    notExists(unmetDeps),
  ];

  if (filters?.priority) {
    conditions.push(eq(tasks.priority, filters.priority));
  }

  const priorityOrder = sql`CASE ${tasks.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

  return filters?.limit
    ? db.select().from(tasks).where(and(...conditions)).orderBy(priorityOrder, asc(tasks.createdAt)).limit(filters.limit).all() as Task[]
    : db.select().from(tasks).where(and(...conditions)).orderBy(priorityOrder, asc(tasks.createdAt)).all() as Task[];
}

export type UpdateTaskResult =
  | { success: true; task: Task }
  | { success: false; notFound: true }
  | { success: false; versionMismatch: true; currentVersion: number };

export function updateTask(id: string, input: UpdateTaskInput, expectedVersion?: number): UpdateTaskResult {
  const db = getDb();
  const now = new Date().toISOString();

  if (expectedVersion !== undefined) {
    const existing = db
      .select({ id: tasks.id, version: tasks.version })
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();
    if (!existing) return { success: false, notFound: true };
    if (existing.version !== expectedVersion) {
      return { success: false, versionMismatch: true, currentVersion: existing.version };
    }
  } else {
    const existing = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).get();
    if (!existing) return { success: false, notFound: true };
  }

  const set: Partial<typeof tasks.$inferInsert> = { updatedAt: now };

  if (input.title !== undefined) set.title = input.title;
  if (input.description !== undefined) set.description = input.description;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.requiredDomain !== undefined) set.requiredDomain = input.requiredDomain;
  if (input.requiredCapabilities !== undefined) set.requiredCapabilities = input.requiredCapabilities;
  if (input.status !== undefined) set.status = input.status;
  if (input.result !== undefined) set.result = input.result;
  if (input.artifacts !== undefined) set.artifacts = input.artifacts;
  if (input.rejectedCount !== undefined) set.rejectedCount = input.rejectedCount;
  if (input.rejectionReason !== undefined) set.rejectionReason = input.rejectionReason;
  if (input.delegatedToAgentId !== undefined) set.delegatedToAgentId = input.delegatedToAgentId;
  if (input.assignedAgentId !== undefined) set.assignedAgentId = input.assignedAgentId;
  if (input.estimatedMinutes !== undefined) set.estimatedMinutes = input.estimatedMinutes;
  if (input.retryPolicy !== undefined) set.retryPolicy = input.retryPolicy;
  if (input.retryCount !== undefined) set.retryCount = input.retryCount;
  if (input.nextRetryAt !== undefined) set.nextRetryAt = input.nextRetryAt;
  if (input.completedAt !== undefined) set.completedAt = input.completedAt;
  if (input.claimedAt !== undefined) set.claimedAt = input.claimedAt;
  if (input.startedAt !== undefined) set.startedAt = input.startedAt;
  if (input.submittedAt !== undefined) set.submittedAt = input.submittedAt;
  if (input.actualMinutes !== undefined) set.actualMinutes = input.actualMinutes;
  if (input.cycleTimeMinutes !== undefined) set.cycleTimeMinutes = input.cycleTimeMinutes;
  if (input.leadTimeMinutes !== undefined) set.leadTimeMinutes = input.leadTimeMinutes;
  if (input.estimationAccuracy !== undefined) set.estimationAccuracy = input.estimationAccuracy;

  db.update(tasks).set({ ...set, version: sql`${tasks.version} + 1` }).where(eq(tasks.id, id)).run();
  const task = getTaskById(id);
  return { success: true, task: task! };
}

export function deleteTask(id: string): void {
  const db = getDb();
  db.delete(tasks).where(eq(tasks.id, id)).run();
}

export function addArtifact(taskId: string, artifact: { type: string; url: string; description: string; createdAt?: string }): boolean {
  const task = getTaskById(taskId);
  if (!task) return false;
  const now = new Date().toISOString();
  const newArtifact = { ...artifact, createdAt: artifact.createdAt ?? now } as Artifact;
  const updated = [...task.artifacts, newArtifact];
  const db = getDb();
  db.update(tasks).set({ artifacts: updated, updatedAt: now }).where(eq(tasks.id, taskId)).run();
  return true;
}

export function claimTask(taskId: string, agentId: string): { success: true; task: Task } | { success: false; reason: string } {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    return db.transaction((tx: any) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) return { success: false as const, reason: 'not_found' };

      if (task.status !== 'pending' || task.assignedAgentId) {
        return { success: false as const, reason: 'already_claimed' };
      }

      if (!areAllDependenciesMet(taskId)) {
        return { success: false as const, reason: 'dependencies_unmet' };
      }

      tx.update(tasks)
        .set({
          assignedAgentId: agentId,
          status: 'claimed',
          claimedAt: now,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        } as unknown as Partial<typeof tasks.$inferInsert>)
        .where(and(eq(tasks.id, taskId), eq(tasks.status, 'pending')))
        .run();

      const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      return { success: true as const, task: updated! };
    });
  } catch {
    return { success: false, reason: 'already_claimed' };
  }
}

export function claimDelegatedTask(taskId: string, agentId: string): { success: true; task: Task } | { success: false; reason: string } {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    return db.transaction((tx: any) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) return { success: false as const, reason: 'not_found' };

      if (task.delegatedToAgentId !== agentId) {
        return { success: false as const, reason: 'not_delegated_to_you' };
      }

      if (task.status !== 'claimed' && task.status !== 'in_progress') {
        return { success: false as const, reason: 'invalid_status' };
      }

      tx.update(tasks)
        .set({
          assignedAgentId: agentId,
          delegatedToAgentId: null,
          status: 'claimed',
          claimedAt: sql`COALESCE(${tasks.claimedAt}, ${now})`,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        } as unknown as Partial<typeof tasks.$inferInsert>)
        .where(eq(tasks.id, taskId))
        .run();

      const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      return { success: true as const, task: updated! };
    });
  } catch {
    return { success: false, reason: 'claim_failed' };
  }
}

export function startTask(taskId: string, agentId: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== 'claimed' || task.assignedAgentId !== agentId) return null;

  db.update(tasks)
    .set({
      status: 'in_progress',
      startedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.assignedAgentId, agentId), eq(tasks.status, 'claimed')))
    .run();

  return getTaskById(taskId);
}

export function submitTask(
  taskId: string,
  agentId: string,
  result: string,
  artifacts: Artifact[]
): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== 'in_progress' || task.assignedAgentId !== agentId) return null;

  db.update(tasks)
    .set({
      status: 'submitted',
      submittedAt: now,
      result,
      artifacts,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.assignedAgentId, agentId), eq(tasks.status, 'in_progress')))
    .run();

  return getTaskById(taskId);
}

export function releaseTask(taskId: string, reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== 'claimed' && task.status !== 'in_progress') return null;

  db.update(tasks)
    .set({
      assignedAgentId: null,
      status: 'pending',
      claimedAt: null,
      startedAt: null,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(eq(tasks.id, taskId))
    .run();

  return getTaskById(taskId);
}

export function failTask(taskId: string, reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== 'in_progress' && task.status !== 'claimed') return null;

  db.update(tasks)
    .set({
      status: 'failed',
      assignedAgentId: null,
      completedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(eq(tasks.id, taskId))
    .run();

  return getTaskById(taskId);
}

export function approveTask(taskId: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({
      status: 'approved',
      completedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'submitted')))
    .run();

  return getTaskById(taskId);
}

export function markTaskDone(taskId: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({
      status: 'done',
      completedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, ['submitted', 'approved'])))
    .run();

  return getTaskById(taskId);
}

export function rejectTask(taskId: string, reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({
      status: 'rejected',
      rejectionReason: reason,
      rejectedCount: sql`${tasks.rejectedCount} + 1`,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, 'submitted')))
    .run();

  return getTaskById(taskId);
}

export function getTasksByDependency(dependsOnId: string): Task[] {
  const db = getDb();
  return db
    .select()
    .from(tasks)
    .innerJoin(taskDependencies, eq(tasks.id, taskDependencies.taskId))
    .where(eq(taskDependencies.dependsOnId, dependsOnId))
    .all()
    .map((row: { tasks: Task }) => row.tasks);
}

export function areAllDependenciesMet(taskId: string): boolean {
  const db = getDb();
  const result = db
    .select({ count: count() })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        notInArray(tasks.status, ['done', 'approved'])
      )
    )
    .get();
  return (result?.count ?? 0) === 0;
}

export function getTasksPendingRetry(): Task[] {
  const db = getDb();
  const now = new Date().toISOString();
  return db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.nextRetryAt),
        lt(tasks.nextRetryAt, now),
        inArray(tasks.status, ['rejected', 'failed'])
      )
    )
    .all() as Task[];
}

export function getTasksByBoardId(
  boardId: string,
  filters?: { status?: TaskStatus; priority?: TaskPriority; search?: string; assignedAgentId?: string | null; limit?: number; offset?: number; isArchived?: boolean }
): { tasks: Task[]; total: number } {
  const db = getDb();

  const featureConditions = [eq(features.boardId, boardId)];
  if (filters?.isArchived !== undefined) {
    featureConditions.push(eq(features.isArchived, filters.isArchived));
  }

  const boardFeatures = db
    .select({ id: features.id })
    .from(features)
    .where(and(...featureConditions))
    .all();
  const boardFeatureIds = boardFeatures.map(f => f.id);

  if (boardFeatureIds.length === 0) return { tasks: [], total: 0 };

  const conditions = [inArray(tasks.featureId, boardFeatureIds)];
  if (filters?.status) conditions.push(eq(tasks.status, filters.status));
  if (filters?.priority) conditions.push(eq(tasks.priority, filters.priority));
  if (filters?.search) {
    const term = `%${filters.search}%`;
    conditions.push(or(like(tasks.title, term), like(tasks.description, term))!);
  }
  if (filters?.assignedAgentId === null) {
    conditions.push(isNull(tasks.assignedAgentId));
  } else if (filters?.assignedAgentId) {
    conditions.push(eq(tasks.assignedAgentId, filters.assignedAgentId));
  }

  const where = and(...conditions);

  const countResult = db
    .select({ total: count() })
    .from(tasks)
    .where(where)
    .get();
  const total = countResult?.total ?? 0;

  const priorityOrder = sql`CASE ${tasks.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

  const results = filters?.limit !== undefined
    ? db.select().from(tasks).where(where).orderBy(priorityOrder, asc(tasks.createdAt)).limit(filters.limit).offset(filters?.offset ?? 0).all()
    : db.select().from(tasks).where(where).orderBy(priorityOrder, asc(tasks.createdAt)).all();

  return { tasks: results as Task[], total };
}

export function getFeatureIdForTask(taskId: string): string | null {
  const task = getTaskById(taskId);
  return task?.featureId ?? null;
}

export function getBoardIdForTask(taskId: string): string | null {
  const task = getTaskById(taskId);
  if (!task) return null;
  const db = getDb();
  const feature = db.select({ boardId: features.boardId }).from(features).where(eq(features.id, task.featureId)).get();
  return feature?.boardId ?? null;
}
