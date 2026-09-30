import { getDb } from "../db/index.js";
import { missionDependencies, missions, taskDependencies, tasks } from "../db/schema/index.js";
import { and, eq } from "drizzle-orm";

export interface TaskDependencyDetails {
  dependsOn: { taskId: string; title: string; status: string; completedAt: string | null }[];
  blocking: { taskId: string; title: string; status: string }[];
}

export interface MissionDependencyDetails {
  dependsOn: { missionId: string; title: string; status: string }[];
  blocking: { missionId: string; title: string; status: string }[];
}

export interface DependencyGraph {
  nodes: { id: string; title: string; status: string }[];
  edges: { from: string; to: string }[];
}

export function addTaskDependency(taskId: string, dependsOnId: string): void {
  const db = getDb();
  db.insert(taskDependencies).values({ taskId, dependsOnId }).run();
}

/**
 * Deletes the exact ordered `(taskId, dependsOnId)` edge via
 * `DELETE ... WHERE task_id = ? AND depends_on_id = ? RETURNING`, so the
 * result reflects only the rows THIS statement matched. Returns true when a
 * row was deleted, false when the exact pair does not exist — on both the
 * sql.js (test) and better-sqlite3 (production) drivers.
 */
export function removeTaskDependency(taskId: string, dependsOnId: string): boolean {
  const db = getDb();
  const matched = db
    .delete(taskDependencies)
    .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)))
    .returning({ taskId: taskDependencies.taskId })
    .all();
  return matched.length > 0;
}

/**
 * Raw ordered edge inventory for Task access checks: every
 * `task_dependencies` row touching `taskId` in BOTH directions, read WITHOUT
 * an inner join to `tasks`. Unlike the joined projection, a dangling edge
 * (endpoint Task row abnormally missing) still surfaces its endpoint id so
 * callers can fail closed instead of silently dropping the row.
 */
export function getTaskDependencyEdgeIds(taskId: string): {
  outgoing: string[];
  incoming: string[];
} {
  const db = getDb();
  const outgoing = db
    .select({ dependsOnId: taskDependencies.dependsOnId })
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, taskId))
    .all();
  const incoming = db
    .select({ blockerId: taskDependencies.taskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.dependsOnId, taskId))
    .all();
  return {
    outgoing: outgoing.map((row) => row.dependsOnId),
    incoming: incoming.map((row) => row.blockerId),
  };
}

export function getTaskDependencies(taskId: string): TaskDependencyDetails {
  const db = getDb();

  const dependsOnRows = db
    .select({
      taskId: taskDependencies.dependsOnId,
      title: tasks.title,
      status: tasks.status,
      completedAt: tasks.completedAt,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(eq(taskDependencies.taskId, taskId))
    .all();

  const blockingRows = db
    .select({
      taskId: taskDependencies.taskId,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.taskId, tasks.id))
    .where(eq(taskDependencies.dependsOnId, taskId))
    .all();

  return {
    dependsOn: dependsOnRows,
    blocking: blockingRows,
  };
}

export function getTaskDependencyStatuses(taskId: string): {
  taskId: string;
  title: string;
  status: string;
}[] {
  const db = getDb();
  return db
    .select({
      taskId: taskDependencies.dependsOnId,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(eq(taskDependencies.taskId, taskId))
    .all();
}

export function addMissionDependency(missionId: string, dependsOnId: string): void {
  const db = getDb();
  db.insert(missionDependencies).values({ missionId, dependsOnId }).run();
}

export function removeMissionDependency(missionId: string, dependsOnId: string): void {
  const db = getDb();
  db.delete(missionDependencies)
    .where(
      and(
        eq(missionDependencies.missionId, missionId),
        eq(missionDependencies.dependsOnId, dependsOnId),
      ),
    )
    .run();
}

export function getMissionDependencies(missionId: string): MissionDependencyDetails {
  const db = getDb();

  const dependsOnRows = db
    .select({
      missionId: missionDependencies.dependsOnId,
      title: missions.title,
      status: missions.status,
    })
    .from(missionDependencies)
    .innerJoin(missions, eq(missionDependencies.dependsOnId, missions.id))
    .where(eq(missionDependencies.missionId, missionId))
    .all();

  const blockingRows = db
    .select({
      missionId: missionDependencies.missionId,
      title: missions.title,
      status: missions.status,
    })
    .from(missionDependencies)
    .innerJoin(missions, eq(missionDependencies.missionId, missions.id))
    .where(eq(missionDependencies.dependsOnId, missionId))
    .all();

  return {
    dependsOn: dependsOnRows,
    blocking: blockingRows,
  };
}

export function getMissionTasks(missionId: string): {
  id: string;
  title: string;
  status: string;
}[] {
  const db = getDb();
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.missionId, missionId))
    .all();
}

export function getMissionDependencyStatuses(missionId: string): {
  missionId: string;
  title: string;
  status: string;
}[] {
  const db = getDb();
  return db
    .select({
      missionId: missionDependencies.dependsOnId,
      title: missions.title,
      status: missions.status,
    })
    .from(missionDependencies)
    .innerJoin(missions, eq(missionDependencies.dependsOnId, missions.id))
    .where(eq(missionDependencies.missionId, missionId))
    .all();
}

export function getDependencyGraph(missionId: string): DependencyGraph {
  const db = getDb();
  const nodes: { id: string; title: string; status: string }[] = [];
  const edges: { from: string; to: string }[] = [];
  const visited = new Set<string>();

  function traverse(fid: string) {
    if (visited.has(fid)) return;
    visited.add(fid);

    const mission = db.select().from(missions).where(eq(missions.id, fid)).get();
    if (!mission) return;
    nodes.push({ id: mission.id, title: mission.title, status: mission.status });

    const deps = db
      .select({ dependsOnId: missionDependencies.dependsOnId })
      .from(missionDependencies)
      .where(eq(missionDependencies.missionId, fid))
      .all();

    for (const dep of deps) {
      edges.push({ from: fid, to: dep.dependsOnId });
      traverse(dep.dependsOnId);
    }
  }

  traverse(missionId);
  return { nodes, edges };
}

export function wouldCreateTaskCycle(fromId: string, toId: string): boolean {
  return wouldCreateCycle(fromId, toId, "task", getDb());
}

export function wouldCreateMissionCycle(fromId: string, toId: string): boolean {
  return wouldCreateCycle(fromId, toId, "mission", getDb());
}

/**
 * Supplied-client variant of {@link wouldCreateMissionCycle}. The caller owns
 * the open `BEGIN IMMEDIATE` reservation (e.g. the triage orphan-map command);
 * walking the graph on the same client observes in-transaction state.
 */
export function wouldCreateMissionCycleWithClient(
  client: Pick<ReturnType<typeof getDb>, "select">,
  fromId: string,
  toId: string,
): boolean {
  return wouldCreateCycle(fromId, toId, "mission", client);
}

function wouldCreateCycle(
  fromId: string,
  toId: string,
  type: "task" | "mission",
  db: Pick<ReturnType<typeof getDb>, "select">,
): boolean {
  const visited = new Set<string>();
  const stack = [toId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === fromId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    if (type === "task") {
      const deps = db
        .select({ dependsOnId: taskDependencies.dependsOnId })
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, current))
        .all();
      for (const dep of deps) {
        stack.push(dep.dependsOnId);
      }
    } else {
      const deps = db
        .select({ dependsOnId: missionDependencies.dependsOnId })
        .from(missionDependencies)
        .where(eq(missionDependencies.missionId, current))
        .all();
      for (const dep of deps) {
        stack.push(dep.dependsOnId);
      }
    }
  }

  return false;
}
