import type { AgentStatus } from "./agent.js";
import type { Anomaly } from "./settings.js";
import type { Task } from "./task.js";
import type { TaskComment } from "./task.js";
import type { Mission, MissionStatus, MissionComment } from "./feature.js";
import type { Column } from "./board.js";
import type { Subtask } from "./task.js";

export type ActorType = "human" | "agent" | "system";

export type EventAction =
  | "created"
  | "claimed"
  | "started"
  | "submitted"
  | "approved"
  | "rejected"
  | "completed"
  | "failed"
  | "moved"
  | "released"
  | "dependency_resolved"
  | "updated"
  | "delegated"
  | "effort_logged"
  | "effort_corrected"
  | "cloned"
  | "retry_scheduled"
  | "retry_executed"
  | "escalated"
  | "code_evidence_linked"
  | "code_evidence_corrected"
  | "code_evidence_gap_reported"
  | "code_evidence_gap_resolved"
  | "code_evidence_marked_not_applicable"
  | "code_evidence_cleared_not_applicable";

export type PresenceType = "human" | "agent";

export interface PresenceEntry {
  sessionId: string;
  type: PresenceType;
  userId?: string;
  userName?: string;
  agentId?: string;
  agentName?: string;
  habitatId: string;
  viewingTaskId?: string | null;
  lastSeen: number;
}

export type SSEEvent =
  | { type: "task.created"; data: Task }
  | { type: "task.updated"; data: Task }
  | { type: "task.moved"; data: { taskId: string; fromColumn: string; toColumn: string } }
  | { type: "task.claimed"; data: { taskId: string; agentId: string } }
  | { type: "task.submitted"; data: { taskId: string; agentId: string } }
  | { type: "task.approved"; data: { taskId: string; reviewerId: string } }
  | { type: "task.rejected"; data: { taskId: string; reason: string; reviewerId: string } }
  | { type: "task.completed"; data: { taskId: string } }
  | { type: "task.failed"; data: { taskId: string; reason: string } }
  | { type: "task.released"; data: { taskId: string; reason: string } }
  | { type: "task.delegated"; data: { taskId: string; fromAgentId: string; toAgentId: string } }
  | { type: "task.cloned"; data: { sourceTaskId: string; clonedTask: Task } }
  | { type: "task.deleted"; data: { taskId: string } }
  | { type: "task.overdue"; data: { taskId: string; habitatId: string; detectedAt: string } }
  | {
      type: "task.watcher_notify";
      data: {
        taskId: string;
        taskTitle: string;
        eventType: string;
        watcherUserIds: string[];
        habitatId: string;
      };
    }
  | {
      type: "task.mentioned";
      data: {
        taskId: string;
        commentId: string;
        mentionedType: "human" | "agent";
        mentionedId: string;
        mentionedName: string;
        habitatId: string;
      };
    }
  | { type: "task.commented"; data: { taskId: string; comment: TaskComment } }
  | { type: "task.comment_deleted"; data: { taskId: string; commentId: string } }
  | { type: "agent.status_changed"; data: { agentId: string; status: AgentStatus } }
  | { type: "agent.heartbeat"; data: { agentId: string; taskId: string | null } }
  | { type: "column.created"; data: Column }
  | { type: "column.updated"; data: Column }
  | { type: "column.deleted"; data: { columnId: string; habitatId: string } }
  | { type: "column.wip_limit_reached"; data: { columnId: string; limit: number } }
  | {
      type: "habitat.created";
      data: { id: string; name: string; description: string; createdAt: string; updatedAt: string };
    }
  | {
      type: "habitat.updated";
      data: { id: string; name: string; description: string; createdAt: string; updatedAt: string };
    }
  | { type: "habitat.deleted"; data: { habitatId: string } }
  | { type: "subtask.created"; data: { taskId: string; subtask: Subtask } }
  | { type: "subtask.updated"; data: { taskId: string; subtask: Subtask } }
  | { type: "subtask.deleted"; data: { taskId: string; subtaskId: string } }
  | { type: "presence.joined"; data: { habitatId: string; presence: PresenceEntry } }
  | { type: "presence.left"; data: { habitatId: string; sessionId: string } }
  | { type: "presence.refresh"; data: { habitatId: string; presence: PresenceEntry } }
  | { type: "presence.summary"; data: { habitatId: string; viewers: PresenceEntry[] } }
  | {
      type: "agent.message_received";
      data: {
        messageId: string;
        fromAgentId: string;
        fromAgentName: string;
        toAgentId: string;
        subject: string;
        messageType: string;
        priority: string;
        taskId: string | null;
        habitatId: string;
      };
    }
  | {
      type: "pulse.signal_posted";
      data: {
        pulseId: string;
        missionId: string | null;
        signalType: string;
        fromType: string;
        fromId: string;
        subject: string;
      };
    }
  | {
      type: "task.retry_scheduled";
      data: { taskId: string; nextRetryAt: string; retryCount: number };
    }
  | { type: "task.retry_executed"; data: { taskId: string; retryCount: number } }
  | { type: "task.escalated"; data: { taskId: string; retryCount: number; reason: string } }
  | { type: "anomaly.detected"; data: Anomaly & { habitatId: string; detectedAt: string } }
  | { type: "mission.created"; data: Mission }
  | { type: "mission.updated"; data: Mission }
  | { type: "mission.moved"; data: { missionId: string; fromColumnId: string; toColumnId: string } }
  | {
      type: "mission.status_changed";
      data: { missionId: string; fromStatus: MissionStatus; toStatus: MissionStatus };
    }
  | { type: "mission.deleted"; data: { missionId: string } }
  | { type: "mission.progress"; data: { missionId: string; completed: number; total: number } }
  | { type: "mission.commented"; data: { missionId: string; comment: MissionComment } }
  | { type: "mission.comment_deleted"; data: { missionId: string; commentId: string } }
  | {
      type: "mission.mentioned";
      data: {
        missionId: string;
        commentId: string;
        mentionedType: "human" | "agent";
        mentionedId: string;
        mentionedName: string;
        habitatId: string;
      };
    }
  | {
      type: "task.priority_changed";
      data: {
        taskId: string;
        ruleName: string;
        oldPriority: string | null;
        newPriority: string;
        score: number;
      };
    }
  | {
      type: "scheduled_task.executed";
      data: { scheduleId: string; missionId: string; missionTitle: string };
    }
  | { type: "scheduled_task.failed"; data: { scheduleId: string; error: string } }
  | { type: "scheduled_task.created"; data: { scheduleId: string; name: string } }
  | {
      type: "task.review_assigned";
      data: { taskId: string; reviewerId: string; reviewerType: string; actorId: string };
    }
  | { type: "task.review_completed"; data: { taskId: string; reviewerId: string; status: string } }
  | { type: "sprint.created"; data: { sprintId: string; habitatId: string } }
  | { type: "sprint.started"; data: { sprintId: string; habitatId: string } }
  | {
      type: "sprint.completed";
      data: { sprintId: string; habitatId: string; completedMissions: number; carriedOver: number };
    }
  | {
      type: "code_evidence.updated";
      data: {
        targetType: "task" | "mission";
        targetId: string;
        missionId?: string;
        evidenceLinkId: string;
        changeKind: "linked" | "corrected" | "gap_reported" | "not_applicable" | "verified";
      };
    }
  | {
      type: "effort.updated";
      data: {
        taskId: string;
        entryId: string;
        actorType: string;
        actorId: string | null;
        source: string;
        minutes: number;
      };
    };

export type PresenceEvent =
  | { type: "presence.joined"; data: { habitatId: string; presence: PresenceEntry } }
  | { type: "presence.left"; data: { habitatId: string; sessionId: string } }
  | { type: "presence.refresh"; data: { habitatId: string; presence: PresenceEntry } }
  | { type: "presence.summary"; data: { habitatId: string; viewers: PresenceEntry[] } };
