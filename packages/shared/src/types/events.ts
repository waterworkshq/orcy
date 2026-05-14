import type { AgentStatus } from './agent.js';
import type { Anomaly } from './settings.js';
import type { Task, TaskStatus } from './task.js';
import type { TaskComment } from './task.js';
import type { Feature, FeatureStatus, FeatureComment } from './feature.js';
import type { Column } from './board.js';
import type { Subtask } from './task.js';

export type ActorType = 'human' | 'agent' | 'system';

export type EventAction =
  | 'created' | 'claimed' | 'started' | 'submitted'
  | 'approved' | 'rejected' | 'completed' | 'failed'
  | 'moved' | 'released' | 'dependency_resolved' | 'updated' | 'delegated' | 'cloned'
  | 'retry_scheduled' | 'retry_executed' | 'escalated';

export type PresenceType = 'human' | 'agent';

export interface PresenceEntry {
  sessionId: string;
  type: PresenceType;
  userId?: string;
  userName?: string;
  agentId?: string;
  agentName?: string;
  boardId: string;
  viewingTaskId?: string | null;
  lastSeen: number;
}

export type SSEEvent =
  | { type: 'task.created'; data: Task }
  | { type: 'task.updated'; data: Task }
  | { type: 'task.moved'; data: { taskId: string; fromColumn: string; toColumn: string } }
  | { type: 'task.claimed'; data: { taskId: string; agentId: string } }
  | { type: 'task.submitted'; data: { taskId: string; agentId: string } }
  | { type: 'task.approved'; data: { taskId: string; reviewerId: string } }
  | { type: 'task.rejected'; data: { taskId: string; reason: string } }
  | { type: 'task.completed'; data: { taskId: string } }
  | { type: 'task.failed'; data: { taskId: string; reason: string } }
  | { type: 'task.released'; data: { taskId: string; reason: string } }
  | { type: 'task.delegated'; data: { taskId: string; fromAgentId: string; toAgentId: string } }
  | { type: 'task.cloned'; data: { sourceTaskId: string; clonedTask: Task } }
  | { type: 'task.deleted'; data: { taskId: string } }
  | { type: 'task.overdue'; data: { taskId: string; boardId: string; detectedAt: string } }
  | { type: 'task.watcher_notify'; data: { taskId: string; taskTitle: string; eventType: string; watcherUserIds: string[]; boardId: string } }
  | { type: 'task.mentioned'; data: { taskId: string; commentId: string; mentionedType: 'human' | 'agent'; mentionedId: string; mentionedName: string; boardId: string } }
  | { type: 'task.commented'; data: { taskId: string; comment: TaskComment } }
  | { type: 'task.comment_deleted'; data: { taskId: string; commentId: string } }
  | { type: 'agent.status_changed'; data: { agentId: string; status: AgentStatus } }
  | { type: 'agent.heartbeat'; data: { agentId: string; taskId: string | null } }
  | { type: 'column.created'; data: Column }
  | { type: 'column.updated'; data: Column }
  | { type: 'column.deleted'; data: { columnId: string; boardId: string } }
  | { type: 'column.wip_limit_reached'; data: { columnId: string; limit: number } }
  | { type: 'board.created'; data: { id: string; name: string; description: string; createdAt: string; updatedAt: string } }
  | { type: 'board.updated'; data: { id: string; name: string; description: string; createdAt: string; updatedAt: string } }
  | { type: 'board.deleted'; data: { boardId: string } }
  | { type: 'subtask.created'; data: { taskId: string; subtask: Subtask } }
  | { type: 'subtask.updated'; data: { taskId: string; subtask: Subtask } }
  | { type: 'subtask.deleted'; data: { taskId: string; subtaskId: string } }
  | { type: 'presence.joined'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.left'; data: { boardId: string; sessionId: string } }
  | { type: 'presence.refresh'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.summary'; data: { boardId: string; viewers: PresenceEntry[] } }
  | { type: 'agent.message_received'; data: { messageId: string; fromAgentId: string; fromAgentName: string; toAgentId: string; subject: string; messageType: string; priority: string; taskId: string | null; boardId: string } }
  | { type: 'pulse.signal_posted'; data: { pulseId: string; missionId: string | null; signalType: string; fromType: string; fromId: string; subject: string } }
  | { type: 'task.retry_scheduled'; data: { taskId: string; nextRetryAt: string; retryCount: number } }
  | { type: 'task.retry_executed'; data: { taskId: string; retryCount: number } }
  | { type: 'task.escalated'; data: { taskId: string; retryCount: number; reason: string } }
  | { type: 'anomaly.detected'; data: Anomaly & { boardId: string; detectedAt: string } }
  | { type: 'feature.created'; data: Feature }
  | { type: 'feature.updated'; data: Feature }
  | { type: 'feature.moved'; data: { featureId: string; fromColumnId: string; toColumnId: string } }
  | { type: 'feature.status_changed'; data: { featureId: string; fromStatus: FeatureStatus; toStatus: FeatureStatus } }
  | { type: 'feature.deleted'; data: { featureId: string } }
  | { type: 'feature.progress'; data: { featureId: string; completed: number; total: number } }
  | { type: 'feature.commented'; data: { featureId: string; comment: FeatureComment } }
  | { type: 'feature.comment_deleted'; data: { featureId: string; commentId: string } }
  | { type: 'feature.mentioned'; data: { featureId: string; commentId: string; mentionedType: 'human' | 'agent'; mentionedId: string; mentionedName: string; boardId: string } }
  | { type: 'task.priority_changed'; data: { taskId: string; ruleName: string; score: number } }
  | { type: 'scheduled_task.executed'; data: { scheduleId: string; featureId: string; featureTitle: string } }
  | { type: 'scheduled_task.failed'; data: { scheduleId: string; error: string } }
  | { type: 'scheduled_task.created'; data: { scheduleId: string; name: string } };

export type PresenceEvent =
  | { type: 'presence.joined'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.left'; data: { boardId: string; sessionId: string } }
  | { type: 'presence.refresh'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.summary'; data: { boardId: string; viewers: PresenceEntry[] } };
