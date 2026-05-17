import type { KanbanApiClient } from '../api.js';

export async function adminListScheduledTasks(
  client: KanbanApiClient,
  args: { boardId: string }
) {
  return client.listScheduledTasks(args.boardId);
}

export async function adminCreateScheduledTask(
  client: KanbanApiClient,
  args: {
    boardId: string;
    name: string;
    description?: string;
    scheduleType: 'once' | 'interval' | 'cron';
    cronExpression?: string;
    intervalMinutes?: number;
    timezone?: string;
    missionTitle: string;
    missionDescription?: string;
    missionPriority?: 'low' | 'medium' | 'high' | 'critical';
    missionLabels?: string[];
    missionDomain?: string;
    tasksTemplate?: Array<{
      title: string;
      description?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      requiredDomain?: string;
      requiredCapabilities?: string[];
      estimatedMinutes?: number;
      order?: number;
    }>;
  }
) {
  return client.createScheduledTask(args.boardId, args);
}

export async function adminRunScheduledTask(
  client: KanbanApiClient,
  args: { scheduledTaskId: string }
) {
  return client.runScheduledTask(args.scheduledTaskId);
}

export async function adminGetScheduledTask(
  client: KanbanApiClient,
  args: { scheduledTaskId: string }
) {
  return client.getScheduledTask(args.scheduledTaskId);
}

export async function adminUpdateScheduledTask(
  client: KanbanApiClient,
  args: {
    scheduledTaskId: string;
    name?: string;
    description?: string;
    scheduleType?: 'once' | 'interval' | 'cron';
    cronExpression?: string;
    intervalMinutes?: number;
    timezone?: string;
    enabled?: boolean;
    missionTitle?: string;
    missionDescription?: string;
    missionPriority?: 'low' | 'medium' | 'high' | 'critical';
    missionLabels?: string[];
    missionDomain?: string;
    tasksTemplate?: Array<{
      title: string;
      description?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      requiredDomain?: string;
      requiredCapabilities?: string[];
      estimatedMinutes?: number;
      order?: number;
    }>;
  }
) {
  const { scheduledTaskId, ...input } = args;
  return client.updateScheduledTask(scheduledTaskId, input);
}

export async function adminDeleteScheduledTask(
  client: KanbanApiClient,
  args: { scheduledTaskId: string }
) {
  return client.deleteScheduledTask(args.scheduledTaskId);
}

export async function adminToggleScheduledTask(
  client: KanbanApiClient,
  args: { scheduledTaskId: string; enabled: boolean }
) {
  return args.enabled
    ? client.enableScheduledTask(args.scheduledTaskId)
    : client.disableScheduledTask(args.scheduledTaskId);
}
