import * as boardRepo from '../repositories/board.js';
import * as taskRepo from '../repositories/task.js';
import * as featureRepo from '../repositories/feature.js';
import * as eventRepo from '../repositories/event.js';
import * as agentRepo from '../repositories/agent.js';
import { getDb } from '../db/index.js';
import { tasks, features, columns, agents, taskEvents, featureEvents } from '../db/schema.js';
import { eq, and, sql, desc, asc, count, inArray, isNotNull } from 'drizzle-orm';
import type { FeatureStatus, TaskStatus } from '../models/index.js';

export interface BoardSummaryOptions {
  since?: '24h' | '7d' | '30d' | 'all';
  maxFeatures?: number;
  includeDigest?: boolean;
}

export interface FeatureNarrative {
  featureTitle: string;
  featureId: string;
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

export interface ActivityPeriod {
  period: string;
  from: string;
  to: string;
  featureNarratives: FeatureNarrative[];
  metrics: {
    featuresCompleted: number;
    featuresCreated: number;
    tasksCompleted: number;
    tasksCreated: number;
    tasksRejected: number;
    avgCycleTimeMinutes: number;
  };
}

export interface BoardSummary {
  board: {
    name: string;
    description: string;
    columns: { name: string; featureCount: number; isTerminal: boolean }[];
    totalFeatures: number;
  };
  snapshot: {
    featuresByStatus: Record<string, number>;
    tasksByStatus: Record<string, number>;
    byPriority: Record<string, number>;
    activeAgents: { name: string; currentTask: string | null }[];
    blockedFeatures: { title: string; blockedBy: string[] }[];
    overdueFeatures: { title: string; dueAt: string }[];
  };
  recentActivity: ActivityPeriod[];
  digest: string;
  generatedAt: string;
}

const NARRATIVE_FEATURE_ACTIONS = new Set([
  'created', 'status_changed', 'moved', 'completed', 'updated',
]);

const NARRATIVE_TASK_ACTIONS = new Set([
  'created', 'claimed', 'started', 'submitted',
  'approved', 'rejected', 'completed', 'failed',
  'released', 'delegated', 'retry_scheduled', 'retry_executed',
  'escalated',
]);

export function generateBoardSummary(
  boardId: string,
  options: BoardSummaryOptions = {}
): BoardSummary | null {
  const since = options.since ?? '7d';
  const maxFeatures = Math.min(options.maxFeatures ?? 20, 50);
  const includeDigest = options.includeDigest !== false;

  const boardData = boardRepo.getBoardWithColumnsAndTasks(boardId);
  if (!boardData) return null;

  const { board, columns: boardColumns } = boardData;
  const { features: featureList } = featureRepo.getFeaturesByBoardId(boardId);
  const { tasks: allTasks } = taskRepo.getTasksByBoardId(boardId);

  const columnFeatureCounts = new Map<string, number>();
  for (const feature of featureList) {
    columnFeatureCounts.set(feature.columnId, (columnFeatureCounts.get(feature.columnId) ?? 0) + 1);
  }

  const columnsWithCounts = boardColumns.map(col => ({
    name: col.name,
    featureCount: columnFeatureCounts.get(col.id) ?? 0,
    isTerminal: col.isTerminal,
  }));

  const snapshot = buildSnapshot(boardId, featureList, allTasks);

  const sinceDate = computeSinceDate(since);
  const events = fetchBoardEvents(boardId, sinceDate);
  const featureEventsList = fetchFeatureEvents(boardId, sinceDate);
  const agentNameMap = buildAgentNameMap();

  const featureNarratives = buildFeatureNarratives(featureList, allTasks, events, featureEventsList, agentNameMap, maxFeatures);
  const periodMetrics = computePeriodMetrics(events, sinceDate);

  const recentActivity = buildActivityPeriods(
    since, sinceDate, events, featureEventsList, featureNarratives, featureList, allTasks, agentNameMap, maxFeatures
  );

  const digest = includeDigest
    ? generateDigest(board.name, columnsWithCounts, snapshot, recentActivity, featureList.length)
    : '';

  return {
    board: {
      name: board.name,
      description: board.description,
      columns: columnsWithCounts,
      totalFeatures: featureList.length,
    },
    snapshot,
    recentActivity,
    digest,
    generatedAt: new Date().toISOString(),
  };
}

function buildSnapshot(
  boardId: string,
  featureList: any[],
  allTasks: any[]
) {
  const featuresByStatus: Record<string, number> = {};
  const tasksByStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const blockedFeatures: { title: string; blockedBy: string[] }[] = [];
  const overdueFeatures: { title: string; dueAt: string }[] = [];

  const now = new Date();
  const featureMap = new Map(featureList.map(f => [f.id, f]));

  for (const feature of featureList) {
    featuresByStatus[feature.status] = (featuresByStatus[feature.status] ?? 0) + 1;
    byPriority[feature.priority] = (byPriority[feature.priority] ?? 0) + 1;

    if (feature.dependsOn && feature.dependsOn.length > 0 && feature.status === 'not_started') {
      const unresolvedDeps = feature.dependsOn
        .map((depId: string) => {
          const dep = featureMap.get(depId);
          return dep && dep.status !== 'done' ? dep.title : null;
        })
        .filter(Boolean) as string[];
      if (unresolvedDeps.length > 0) {
        blockedFeatures.push({ title: feature.title, blockedBy: unresolvedDeps });
      }
    }

    if (feature.dueAt && new Date(feature.dueAt) < now && !['done'].includes(feature.status)) {
      overdueFeatures.push({ title: feature.title, dueAt: feature.dueAt });
    }
  }

  for (const task of allTasks) {
    tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
  }

  const agentRows = agentRepo.listAgents();
  const activeAgents = agentRows
    .filter(a => a.status === 'working')
    .map(a => {
      const currentTask = a.currentTaskId
        ? allTasks.find(t => t.id === a.currentTaskId)?.title ?? null
        : null;
      return { name: a.name, currentTask };
    });

  return { featuresByStatus, tasksByStatus, byPriority, activeAgents, blockedFeatures, overdueFeatures };
}

interface RawBoardEvent {
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

interface RawFeatureEvent {
  id: string;
  featureId: string;
  actorType: string;
  actorId: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

function fetchBoardEvents(boardId: string, sinceDate: string): RawBoardEvent[] {
  const result = eventRepo.getEventsByBoardId(boardId, 500, 0, { since: sinceDate });
  return result.events.map(e => ({
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

function fetchFeatureEvents(boardId: string, sinceDate: string): RawFeatureEvent[] {
  const result = eventRepo.getFeatureEventsByBoardId(boardId, 500, 0);
  return result.events
    .filter(e => e.timestamp >= sinceDate)
    .map(e => ({
      id: e.id,
      featureId: e.featureId,
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

function buildFeatureNarratives(
  featureList: any[],
  allTasks: any[],
  events: RawBoardEvent[],
  featureEvents: RawFeatureEvent[],
  agentNameMap: Map<string, string>,
  maxFeatures: number
): FeatureNarrative[] {
  const featureTaskMap = new Map<string, any[]>();
  for (const task of allTasks) {
    const list = featureTaskMap.get(task.featureId) ?? [];
    list.push(task);
    featureTaskMap.set(task.featureId, list);
  }

  const taskFeatureMap = new Map<string, string>();
  for (const task of allTasks) {
    taskFeatureMap.set(task.id, task.featureId);
  }

  const featureTimeline = new Map<string, { action: string; actor: string; timestamp: string; detail?: string }[]>();

  for (const event of featureEvents) {
    if (!NARRATIVE_FEATURE_ACTIONS.has(event.action)) continue;
    const timeline = featureTimeline.get(event.featureId) ?? [];
    timeline.push({
      action: event.action,
      actor: resolveActorName(event.actorType, event.actorId, null, agentNameMap),
      timestamp: event.timestamp,
    });
    featureTimeline.set(event.featureId, timeline);
  }

  for (const event of events) {
    if (!NARRATIVE_TASK_ACTIONS.has(event.action)) continue;
    const featureId = taskFeatureMap.get(event.taskId);
    if (!featureId) continue;
    const timeline = featureTimeline.get(featureId) ?? [];
    timeline.push({
      action: `task.${event.action}`,
      actor: resolveActorName(event.actorType, event.actorId, event.actorName, agentNameMap),
      timestamp: event.timestamp,
      detail: extractEventDetail(event),
    });
    featureTimeline.set(featureId, timeline);
  }

  const featureLastActivity = new Map<string, string>();
  for (const [featureId, timeline] of featureTimeline) {
    const sorted = timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    featureLastActivity.set(featureId, sorted[sorted.length - 1].timestamp);
  }

  const sortedFeatureIds = [...featureLastActivity.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, maxFeatures)
    .map(([id]) => id);

  const featureMap = new Map(featureList.map(f => [f.id, f]));

  return sortedFeatureIds.map(featureId => {
    const feature = featureMap.get(featureId);
    const featureTasks = featureTaskMap.get(featureId) ?? [];
    const timeline = featureTimeline.get(featureId) ?? [];
    timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      featureTitle: feature?.title ?? 'Unknown',
      featureId,
      priority: feature?.priority ?? 'medium',
      currentStatus: feature?.status ?? 'unknown',
      progress: {
        total: featureTasks.length,
        done: featureTasks.filter(t => ['done', 'approved'].includes(t.status)).length,
      },
      timeline,
    };
  });
}

function resolveActorName(actorType: string, actorId: string, actorName: string | null, agentNameMap: Map<string, string>): string {
  if (actorType === 'system') return 'System';
  if (actorType === 'human') return 'Human';
  return actorName ?? agentNameMap.get(actorId) ?? actorId;
}

function extractEventDetail(event: RawBoardEvent): string | undefined {
  const metadata = event.metadata;
  if (event.action === 'rejected' && metadata.reason) return String(metadata.reason);
  if (event.action === 'submitted' && metadata.result) {
    const result = String(metadata.result);
    return result.length > 200 ? result.slice(0, 200) + '...' : result;
  }
  if (event.action === 'failed' && metadata.reason) return String(metadata.reason);
  if (event.action === 'released' && metadata.reason) return String(metadata.reason);
  return undefined;
}

function computePeriodMetrics(events: RawBoardEvent[], sinceDate: string) {
  let tasksCompleted = 0;
  let tasksCreated = 0;
  let tasksRejected = 0;

  for (const event of events) {
    if (event.timestamp < sinceDate) continue;
    switch (event.action) {
      case 'completed':
      case 'approved':
        tasksCompleted++;
        break;
      case 'created':
        tasksCreated++;
        break;
      case 'rejected':
        tasksRejected++;
        break;
    }
  }

  return { tasksCompleted, tasksCreated, tasksRejected };
}

function buildActivityPeriods(
  since: string,
  sinceDate: string,
  allEvents: RawBoardEvent[],
  allFeatureEvents: RawFeatureEvent[],
  allNarratives: FeatureNarrative[],
  featureList: any[],
  allTasks: any[],
  agentNameMap: Map<string, string>,
  maxFeatures: number
): ActivityPeriod[] {
  const now = new Date();
  const buckets = computeBuckets(since, now);

  const taskFeatureMap = new Map<string, string>();
  for (const task of allTasks) {
    taskFeatureMap.set(task.id, task.featureId);
  }

  return buckets.map(bucket => {
    const bucketTaskEvents = allEvents.filter(e => e.timestamp >= bucket.from && e.timestamp < bucket.to);
    const bucketFeatureEvents = allFeatureEvents.filter(e => e.timestamp >= bucket.from && e.timestamp < bucket.to);

    const activeFeatureIds = new Set<string>();
    for (const e of bucketFeatureEvents) activeFeatureIds.add(e.featureId);
    for (const e of bucketTaskEvents) {
      const fid = taskFeatureMap.get(e.taskId);
      if (fid) activeFeatureIds.add(fid);
    }

    const bucketNarratives = allNarratives.filter(n => activeFeatureIds.has(n.featureId));

    const metrics = computePeriodMetrics(bucketTaskEvents, bucket.from);
    const featuresCompleted = bucketFeatureEvents.filter(e => e.action === 'completed').length;
    const featuresCreated = bucketFeatureEvents.filter(e => e.action === 'created').length;

    return {
      period: bucket.label,
      from: bucket.from,
      to: bucket.to,
      featureNarratives: bucketNarratives,
      metrics: {
        featuresCompleted,
        featuresCreated,
        tasksCompleted: metrics.tasksCompleted,
        tasksCreated: metrics.tasksCreated,
        tasksRejected: metrics.tasksRejected,
        avgCycleTimeMinutes: 0,
      },
    };
  });
}

interface TimeBucket {
  label: string;
  from: string;
  to: string;
}

function computeBuckets(since: string, now: Date): TimeBucket[] {
  const toIso = (d: Date) => d.toISOString();
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  switch (since) {
    case '24h': {
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      return [{ label: 'last_24h', from: toIso(from), to: toIso(now) }];
    }
    case '7d': {
      const today = dayStart(now);
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return [
        { label: 'today', from: toIso(today), to: toIso(now) },
        { label: 'yesterday', from: toIso(yesterday), to: toIso(today) },
        { label: 'earlier_this_week', from: toIso(weekAgo), to: toIso(yesterday) },
      ];
    }
    case '30d': {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return [
        { label: 'last_7_days', from: toIso(weekAgo), to: toIso(now) },
        { label: 'earlier_this_month', from: toIso(monthAgo), to: toIso(weekAgo) },
      ];
    }
    case 'all':
    default: {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return [
        { label: 'last_7_days', from: toIso(weekAgo), to: toIso(now) },
        { label: 'last_30_days', from: toIso(monthAgo), to: toIso(weekAgo) },
        { label: 'older', from: '2000-01-01T00:00:00.000Z', to: toIso(monthAgo) },
      ];
    }
  }
}

function computeSinceDate(since: string): string {
  const now = Date.now();
  switch (since) {
    case '24h': return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    case '7d': return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    case '30d': return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    case 'all': return '2000-01-01T00:00:00.000Z';
    default: return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

function generateDigest(
  boardName: string,
  columns: { name: string; featureCount: number; isTerminal: boolean }[],
  snapshot: BoardSummary['snapshot'],
  activity: ActivityPeriod[],
  totalFeatures: number
): string {
  const lines: string[] = [];
  lines.push(`# Board Summary: ${boardName}`);
  lines.push('');

  lines.push('## Current State');
  const colSummary = columns.map(c => `${c.name}: ${c.featureCount}`).join(' | ');
  lines.push(`**Columns:** ${colSummary}`);
  lines.push(`**Total features:** ${totalFeatures}`);
  lines.push('');

  const statusParts = Object.entries(snapshot.featuresByStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}: ${count}`);
  if (statusParts.length > 0) lines.push(`**Features by status:** ${statusParts.join(', ')}`);

  const taskParts = Object.entries(snapshot.tasksByStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}: ${count}`);
  if (taskParts.length > 0) lines.push(`**Tasks by status:** ${taskParts.join(', ')}`);

  const prioParts = Object.entries(snapshot.byPriority)
    .filter(([, count]) => count > 0)
    .map(([prio, count]) => `${prio}: ${count}`);
  if (prioParts.length > 0) lines.push(`**By priority:** ${prioParts.join(', ')}`);
  lines.push('');

  if (snapshot.activeAgents.length > 0) {
    lines.push('## Active Agents');
    for (const agent of snapshot.activeAgents) lines.push(`- **${agent.name}**: ${agent.currentTask ?? 'idle'}`);
    lines.push('');
  }

  if (snapshot.blockedFeatures.length > 0) {
    lines.push('## Blocked Features');
    for (const bf of snapshot.blockedFeatures) lines.push(`- "${bf.title}" — blocked by: ${bf.blockedBy.join(', ')}`);
    lines.push('');
  }

  if (snapshot.overdueFeatures.length > 0) {
    lines.push('## Overdue Features');
    for (const of of snapshot.overdueFeatures) lines.push(`- "${of.title}" — due: ${formatTimestamp(of.dueAt)}`);
    lines.push('');
  }

  for (const period of activity) {
    if (period.featureNarratives.length === 0 && period.metrics.featuresCompleted === 0) continue;
    lines.push(`## Activity: ${formatPeriodLabel(period.period)}`);
    lines.push(
      `Features completed: ${period.metrics.featuresCompleted} | ` +
      `Tasks completed: ${period.metrics.tasksCompleted} | ` +
      `Rejected: ${period.metrics.tasksRejected}`
    );
    lines.push('');

    for (const narrative of period.featureNarratives) {
      lines.push(`### "${narrative.featureTitle}" (${narrative.priority}, ${narrative.currentStatus}) [${narrative.progress.done}/${narrative.progress.total} tasks]`);
      for (const event of narrative.timeline.slice(-5)) {
        const detail = event.detail ? `: "${event.detail}"` : '';
        lines.push(`  → ${capitalize(event.action)} by ${event.actor} @ ${formatTimestamp(event.timestamp)}${detail}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const month = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();
    const hours = d.getHours().toString().padStart(2, '0');
    const minutes = d.getMinutes().toString().padStart(2, '0');
    return `${month} ${day} ${hours}:${minutes}`;
  } catch { return iso; }
}

function formatPeriodLabel(label: string): string {
  return label.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}
