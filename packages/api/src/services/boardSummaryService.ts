import * as habitatRepo from "../repositories/board.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as eventRepo from "../repositories/event.js";
import * as agentRepo from "../repositories/agent.js";
import { MS_PER_DAY } from "./analyticsDate.js";

/** Options controlling the time window, mission cap, and digest inclusion for a generated habitat summary. */
export interface HabitatSummaryOptions {
  since?: "24h" | "7d" | "30d" | "all";
  maxMissions?: number;
  includeDigest?: boolean;
}

/** Human-readable narrative for a single mission: status, progress, and a timeline of notable events. */
export interface MissionNarrative {
  missionTitle: string;
  missionId: string;
  priority: string;
  currentStatus: string;
  progress: { total: number; done: number };
  timeline: {
    action: string;
    actor: string;
    timestamp: string;
    detail?: string;
  }[];
}

/** Aggregated activity and metrics for a single time bucket within a habitat summary's lookback window. */
export interface ActivityPeriod {
  period: string;
  from: string;
  to: string;
  missionNarratives: MissionNarrative[];
  metrics: {
    missionsCompleted: number;
    missionsCreated: number;
    tasksCompleted: number;
    tasksCreated: number;
    tasksRejected: number;
    avgCycleTimeMinutes: number | null;
  };
}

/** Top-level habitat summary combining current snapshot, recent activity, and an optional digest. Produced by {@link generateHabitatSummary}. */
export interface HabitatSummary {
  habitat: {
    name: string;
    description: string;
    columns: { name: string; missionCount: number; isTerminal: boolean }[];
    totalMissions: number;
  };
  snapshot: {
    missionsByStatus: Record<string, number>;
    tasksByStatus: Record<string, number>;
    byPriority: Record<string, number>;
    activeAgents: { name: string; currentTask: string | null }[];
    blockedMissions: { title: string; blockedBy: string[] }[];
    overdueMissions: { title: string; dueAt: string }[];
  };
  recentActivity: ActivityPeriod[];
  digest: string;
  generatedAt: string;
}

const NARRATIVE_MISSION_ACTIONS = new Set([
  "created",
  "status_changed",
  "moved",
  "completed",
  "updated",
]);

const NARRATIVE_TASK_ACTIONS = new Set([
  "created",
  "claimed",
  "started",
  "submitted",
  "approved",
  "rejected",
  "completed",
  "failed",
  "released",
  "delegated",
  "retry_scheduled",
  "retry_executed",
  "escalated",
]);

/** Generates a full habitat summary (snapshot, activity periods, optional digest) from repository data. Returns `null` if the habitat does not exist. */
export function generateHabitatSummary(
  habitatId: string,
  options: HabitatSummaryOptions = {},
): HabitatSummary | null {
  const since = options.since ?? "7d";
  const maxMissions = Math.min(options.maxMissions ?? 20, 50);
  const includeDigest = options.includeDigest !== false;

  const habitatData = habitatRepo.getHabitatWithColumnsAndTasks(habitatId);
  if (!habitatData) return null;

  const { habitat, columns: habitatColumns } = habitatData;
  const { missions: missionList } = missionRepo.getMissionsByHabitatId(habitatId);
  const { tasks: allTasks } = taskRepo.getTasksByHabitatId(habitatId);

  const columnMissionCounts = new Map<string, number>();
  for (const mission of missionList) {
    columnMissionCounts.set(mission.columnId, (columnMissionCounts.get(mission.columnId) ?? 0) + 1);
  }

  const columnsWithCounts = habitatColumns.map((col) => ({
    name: col.name,
    missionCount: columnMissionCounts.get(col.id) ?? 0,
    isTerminal: col.isTerminal,
  }));

  const snapshot = buildSnapshot(habitatId, missionList, allTasks);

  const sinceDate = computeSinceDate(since);
  const events = fetchHabitatEvents(habitatId, sinceDate);
  const missionEventsList = fetchMissionEvents(habitatId, sinceDate);
  const agentNameMap = buildAgentNameMap();

  const missionNarratives = buildMissionNarratives(
    missionList,
    allTasks,
    events,
    missionEventsList,
    agentNameMap,
    maxMissions,
  );

  const recentActivity = buildActivityPeriods(
    since,
    sinceDate,
    events,
    missionEventsList,
    missionNarratives,
    missionList,
    allTasks,
    agentNameMap,
    maxMissions,
  );

  const digest = includeDigest
    ? generateDigest(habitat.name, columnsWithCounts, snapshot, recentActivity, missionList.length)
    : "";

  return {
    habitat: {
      name: habitat.name,
      description: habitat.description,
      columns: columnsWithCounts,
      totalMissions: missionList.length,
    },
    snapshot,
    recentActivity,
    digest,
    generatedAt: new Date().toISOString(),
  };
}

function buildSnapshot(habitatId: string, missionList: any[], allTasks: any[]) {
  const missionsByStatus: Record<string, number> = {};
  const tasksByStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const blockedMissions: { title: string; blockedBy: string[] }[] = [];
  const overdueMissions: { title: string; dueAt: string }[] = [];

  const now = new Date();
  const missionMap = new Map(missionList.map((f) => [f.id, f]));

  for (const mission of missionList) {
    missionsByStatus[mission.status] = (missionsByStatus[mission.status] ?? 0) + 1;
    byPriority[mission.priority] = (byPriority[mission.priority] ?? 0) + 1;

    if (mission.dependsOn && mission.dependsOn.length > 0 && mission.status === "not_started") {
      const unresolvedDeps = mission.dependsOn
        .map((depId: string) => {
          const dep = missionMap.get(depId);
          return dep && dep.status !== "done" ? dep.title : null;
        })
        .filter(Boolean) as string[];
      if (unresolvedDeps.length > 0) {
        blockedMissions.push({ title: mission.title, blockedBy: unresolvedDeps });
      }
    }

    if (mission.dueAt && new Date(mission.dueAt) < now && !["done"].includes(mission.status)) {
      overdueMissions.push({ title: mission.title, dueAt: mission.dueAt });
    }
  }

  for (const task of allTasks) {
    tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
  }

  const agentRows = agentRepo.listAgents();
  const activeAgents = agentRows
    .filter((a) => a.status === "working")
    .map((a) => {
      const currentTask = a.currentTaskId
        ? (allTasks.find((t) => t.id === a.currentTaskId)?.title ?? null)
        : null;
      return { name: a.name, currentTask };
    });

  return {
    missionsByStatus,
    tasksByStatus,
    byPriority,
    activeAgents,
    blockedMissions,
    overdueMissions,
  };
}

interface RawHabitatEvent {
  id: string;
  taskId: string;
  taskTitle: string;
  actorType: string;
  actorId: string;
  actorName: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

interface RawMissionEvent {
  id: string;
  missionId: string;
  actorType: string;
  actorId: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

function fetchHabitatEvents(habitatId: string, sinceDate: string): RawHabitatEvent[] {
  const result = eventRepo.getEventsByHabitatId(habitatId, 500, 0, { since: sinceDate });
  return result.events.map((e) => ({
    id: e.id,
    taskId: e.taskId,
    taskTitle: e.taskTitle,
    actorType: e.actorType,
    actorId: e.actorId,
    actorName: e.actorName,
    action: e.action,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    metadata: e.metadata ?? {},
    timestamp: e.timestamp,
  }));
}

function fetchMissionEvents(habitatId: string, sinceDate: string): RawMissionEvent[] {
  const result = eventRepo.getMissionEventsByHabitatId(habitatId, 500, 0);
  return result.events
    .filter((e) => e.timestamp >= sinceDate)
    .map((e) => ({
      id: e.id,
      missionId: e.missionId,
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      metadata: e.metadata ?? {},
      timestamp: e.timestamp,
    }));
}

function buildAgentNameMap(): Map<string, string> {
  const agentRows = agentRepo.listAgents();
  const map = new Map<string, string>();
  for (const agent of agentRows) {
    map.set(agent.id, agent.name);
  }
  return map;
}

function buildMissionNarratives(
  missionList: any[],
  allTasks: any[],
  events: RawHabitatEvent[],
  missionEventList: RawMissionEvent[],
  agentNameMap: Map<string, string>,
  _maxMissions: number,
): MissionNarrative[] {
  const missionTaskMap = new Map<string, any[]>();
  for (const task of allTasks) {
    const list = missionTaskMap.get(task.missionId) ?? [];
    list.push(task);
    missionTaskMap.set(task.missionId, list);
  }

  const taskMissionMap = new Map<string, string>();
  for (const task of allTasks) {
    taskMissionMap.set(task.id, task.missionId);
  }

  const missionTimeline = new Map<
    string,
    { action: string; actor: string; timestamp: string; detail?: string }[]
  >();

  for (const event of missionEventList) {
    if (!NARRATIVE_MISSION_ACTIONS.has(event.action)) continue;
    const timeline = missionTimeline.get(event.missionId) ?? [];
    timeline.push({
      action: event.action,
      actor: resolveActorName(event.actorType, event.actorId, null, agentNameMap),
      timestamp: event.timestamp,
    });
    missionTimeline.set(event.missionId, timeline);
  }

  for (const event of events) {
    if (!NARRATIVE_TASK_ACTIONS.has(event.action)) continue;
    const missionId = taskMissionMap.get(event.taskId);
    if (!missionId) continue;
    const timeline = missionTimeline.get(missionId) ?? [];
    timeline.push({
      action: `task.${event.action}`,
      actor: resolveActorName(event.actorType, event.actorId, event.actorName, agentNameMap),
      timestamp: event.timestamp,
      detail: extractEventDetail(event),
    });
    missionTimeline.set(missionId, timeline);
  }

  const missionLastActivity = new Map<string, string>();
  for (const [missionId, timeline] of missionTimeline) {
    const sorted = timeline.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
    missionLastActivity.set(missionId, sorted[sorted.length - 1].timestamp);
  }

  const sortedMissionIds = [...missionLastActivity.entries()]
    .toSorted((a, b) => b[1].localeCompare(a[1]))
    .slice(0, _maxMissions)
    .map(([id]) => id);

  const missionMap = new Map(missionList.map((f) => [f.id, f]));

  return sortedMissionIds.map((missionId) => {
    const mission = missionMap.get(missionId);
    const missionTasks = missionTaskMap.get(missionId) ?? [];
    const timeline = missionTimeline.get(missionId) ?? [];
    timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      missionTitle: mission?.title ?? "Unknown",
      missionId,
      priority: mission?.priority ?? "medium",
      currentStatus: mission?.status ?? "unknown",
      progress: {
        total: missionTasks.length,
        done: missionTasks.filter((t) => ["done", "approved"].includes(t.status)).length,
      },
      timeline,
    };
  });
}

function resolveActorName(
  actorType: string,
  actorId: string,
  actorName: string | null,
  agentNameMap: Map<string, string>,
): string {
  if (actorType === "system") return "System";
  if (actorType === "human") return "Human";
  return actorName ?? agentNameMap.get(actorId) ?? actorId;
}

function extractEventDetail(event: RawHabitatEvent): string | undefined {
  const metadata = event.metadata;
  if (event.action === "rejected" && metadata.reason) return String(metadata.reason);
  if (event.action === "submitted" && metadata.result) {
    const result = String(metadata.result);
    return result.length > 200 ? result.slice(0, 200) + "..." : result;
  }
  if (event.action === "failed" && metadata.reason) return String(metadata.reason);
  if (event.action === "released" && metadata.reason) return String(metadata.reason);
  return undefined;
}

function computePeriodMetrics(events: RawHabitatEvent[], sinceDate: string) {
  let tasksCompleted = 0;
  let tasksCreated = 0;
  let tasksRejected = 0;

  for (const event of events) {
    if (event.timestamp < sinceDate) continue;
    switch (event.action) {
      case "completed":
      case "approved":
        tasksCompleted++;
        break;
      case "created":
        tasksCreated++;
        break;
      case "rejected":
        tasksRejected++;
        break;
    }
  }

  return { tasksCompleted, tasksCreated, tasksRejected };
}

function computeAverageCycleTimeMinutes(
  tasksForHabitat: any[],
  from: string,
  to: string,
): number | null {
  const samples = tasksForHabitat
    .filter(
      (task) =>
        ["done", "approved"].includes(task.status) &&
        task.claimedAt &&
        task.completedAt &&
        task.completedAt >= from &&
        task.completedAt < to,
    )
    .map((task) => {
      const claimed = new Date(task.claimedAt).getTime();
      const completed = new Date(task.completedAt).getTime();
      return (completed - claimed) / 60000;
    })
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0);

  if (samples.length === 0) return null;
  return Math.round(samples.reduce((sum, minutes) => sum + minutes, 0) / samples.length);
}

function buildActivityPeriods(
  since: string,
  sinceDate: string,
  allEvents: RawHabitatEvent[],
  allMissionEvents: RawMissionEvent[],
  allNarratives: MissionNarrative[],
  missionList: any[],
  allTasks: any[],
  _agentNameMap: Map<string, string>,
  _maxMissions: number,
): ActivityPeriod[] {
  const now = new Date();
  const buckets = computeBuckets(since, now);

  const taskMissionMap = new Map<string, string>();
  for (const task of allTasks) {
    taskMissionMap.set(task.id, task.missionId);
  }

  return buckets.map((bucket) => {
    const bucketTaskEvents = allEvents.filter(
      (e) => e.timestamp >= bucket.from && e.timestamp < bucket.to,
    );
    const bucketMissionEvents = allMissionEvents.filter(
      (e) => e.timestamp >= bucket.from && e.timestamp < bucket.to,
    );

    const activeMissionIds = new Set<string>();
    for (const e of bucketMissionEvents) activeMissionIds.add(e.missionId);
    for (const e of bucketTaskEvents) {
      const fid = taskMissionMap.get(e.taskId);
      if (fid) activeMissionIds.add(fid);
    }

    const bucketNarratives = allNarratives.filter((n) => activeMissionIds.has(n.missionId));

    const metrics = computePeriodMetrics(bucketTaskEvents, bucket.from);
    const missionsCompleted = bucketMissionEvents.filter((e) => e.action === "completed").length;
    const missionsCreated = bucketMissionEvents.filter((e) => e.action === "created").length;

    return {
      period: bucket.label,
      from: bucket.from,
      to: bucket.to,
      missionNarratives: bucketNarratives,
      metrics: {
        missionsCompleted,
        missionsCreated,
        tasksCompleted: metrics.tasksCompleted,
        tasksCreated: metrics.tasksCreated,
        tasksRejected: metrics.tasksRejected,
        avgCycleTimeMinutes: computeAverageCycleTimeMinutes(allTasks, bucket.from, bucket.to),
      },
    };
  });
}

interface TimeBucket {
  label: string;
  from: string;
  to: string;
}

function toIso(d: Date): string {
  return d.toISOString();
}

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function computeBuckets(since: string, now: Date): TimeBucket[] {
  switch (since) {
    case "24h": {
      const from = new Date(now.getTime() - MS_PER_DAY);
      return [{ label: "last_24h", from: toIso(from), to: toIso(now) }];
    }
    case "7d": {
      const today = dayStart(now);
      const yesterday = new Date(today.getTime() - MS_PER_DAY);
      const weekAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
      return [
        { label: "today", from: toIso(today), to: toIso(now) },
        { label: "yesterday", from: toIso(yesterday), to: toIso(today) },
        { label: "earlier_this_week", from: toIso(weekAgo), to: toIso(yesterday) },
      ];
    }
    case "30d": {
      const weekAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
      const monthAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
      return [
        { label: "last_7_days", from: toIso(weekAgo), to: toIso(now) },
        { label: "earlier_this_month", from: toIso(monthAgo), to: toIso(weekAgo) },
      ];
    }
    case "all":
    default: {
      const weekAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
      const monthAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
      return [
        { label: "last_7_days", from: toIso(weekAgo), to: toIso(now) },
        { label: "last_30_days", from: toIso(monthAgo), to: toIso(weekAgo) },
        { label: "older", from: "2000-01-01T00:00:00.000Z", to: toIso(monthAgo) },
      ];
    }
  }
}

function computeSinceDate(since: string): string {
  const now = Date.now();
  switch (since) {
    case "24h":
      return new Date(now - MS_PER_DAY).toISOString();
    case "7d":
      return new Date(now - 7 * MS_PER_DAY).toISOString();
    case "30d":
      return new Date(now - 30 * MS_PER_DAY).toISOString();
    case "all":
      return "2000-01-01T00:00:00.000Z";
    default:
      return new Date(now - 7 * MS_PER_DAY).toISOString();
  }
}

function generateDigest(
  habitatName: string,
  digestColumns: { name: string; missionCount: number; isTerminal: boolean }[],
  snapshot: HabitatSummary["snapshot"],
  activity: ActivityPeriod[],
  totalMissions: number,
): string {
  const lines: string[] = [];
  lines.push(`# Habitat Summary: ${habitatName}`);
  lines.push("");

  lines.push("## Current State");
  const colSummary = digestColumns.map((c) => `${c.name}: ${c.missionCount}`).join(" | ");
  lines.push(`**Columns:** ${colSummary}`);
  lines.push(`**Total missions:** ${totalMissions}`);
  lines.push("");

  const statusParts = Object.entries(snapshot.missionsByStatus)
    .filter(([, cnt]) => cnt > 0)
    .map(([status, cnt]) => `${status}: ${cnt}`);
  if (statusParts.length > 0) lines.push(`**Missions by status:** ${statusParts.join(", ")}`);

  const taskParts = Object.entries(snapshot.tasksByStatus)
    .filter(([, cnt]) => cnt > 0)
    .map(([status, cnt]) => `${status}: ${cnt}`);
  if (taskParts.length > 0) lines.push(`**Tasks by status:** ${taskParts.join(", ")}`);

  const prioParts = Object.entries(snapshot.byPriority)
    .filter(([, cnt]) => cnt > 0)
    .map(([prio, cnt]) => `${prio}: ${cnt}`);
  if (prioParts.length > 0) lines.push(`**By priority:** ${prioParts.join(", ")}`);
  lines.push("");

  if (snapshot.activeAgents.length > 0) {
    lines.push("## Active Agents");
    for (const agent of snapshot.activeAgents)
      lines.push(`- **${agent.name}**: ${agent.currentTask ?? "idle"}`);
    lines.push("");
  }

  if (snapshot.blockedMissions.length > 0) {
    lines.push("## Blocked Missions");
    for (const bf of snapshot.blockedMissions)
      lines.push(`- "${bf.title}" — blocked by: ${bf.blockedBy.join(", ")}`);
    lines.push("");
  }

  if (snapshot.overdueMissions.length > 0) {
    lines.push("## Overdue Missions");
    for (const of of snapshot.overdueMissions)
      lines.push(`- "${of.title}" — due: ${formatTimestamp(of.dueAt)}`);
    lines.push("");
  }

  for (const period of activity) {
    if (period.missionNarratives.length === 0 && period.metrics.missionsCompleted === 0) continue;
    lines.push(`## Activity: ${formatPeriodLabel(period.period)}`);
    lines.push(
      `Missions completed: ${period.metrics.missionsCompleted} | ` +
        `Tasks completed: ${period.metrics.tasksCompleted} | ` +
        `Rejected: ${period.metrics.tasksRejected}`,
    );
    lines.push("");

    for (const narrative of period.missionNarratives) {
      lines.push(
        `### "${narrative.missionTitle}" (${narrative.priority}, ${narrative.currentStatus}) [${narrative.progress.done}/${narrative.progress.total} tasks]`,
      );
      for (const event of narrative.timeline.slice(-5)) {
        const detail = event.detail ? `: "${event.detail}"` : "";
        lines.push(
          `  → ${capitalize(event.action)} by ${event.actor} @ ${formatTimestamp(event.timestamp)}${detail}`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const month = d.toLocaleString("en-US", { month: "short" });
    const day = d.getDate();
    const hours = d.getHours().toString().padStart(2, "0");
    const minutes = d.getMinutes().toString().padStart(2, "0");
    return `${month} ${day} ${hours}:${minutes}`;
  } catch {
    return iso;
  }
}

function formatPeriodLabel(label: string): string {
  return label.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}
