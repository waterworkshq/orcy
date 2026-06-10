import type { ScheduledTaskClient } from '../api/interfaces.js';

/**
 * @requires ScheduledTaskClient
 */
export async function adminListScheduledTasks(
  client: ScheduledTaskClient,
  args: { boardId: string }
) {
  return client.listScheduledTasks(args.boardId);
}

/**
 * @requires ScheduledTaskClient
 */
export async function adminCreateScheduledTask(
  client: ScheduledTaskClient,
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

/**
 * @requires ScheduledTaskClient
 */
export async function adminRunScheduledTask(
  client: ScheduledTaskClient,
  args: { scheduledTaskId: string }
) {
  return client.runScheduledTask(args.scheduledTaskId);
}

/**
 * @requires ScheduledTaskClient
 */
export async function adminGetScheduledTask(
  client: ScheduledTaskClient,
  args: { scheduledTaskId: string }
) {
  return client.getScheduledTask(args.scheduledTaskId);
}

/**
 * @requires ScheduledTaskClient
 */
export async function adminUpdateScheduledTask(
  client: ScheduledTaskClient,
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

/**
 * @requires ScheduledTaskClient
 */
export async function adminDeleteScheduledTask(
  client: ScheduledTaskClient,
  args: { scheduledTaskId: string }
) {
  return client.deleteScheduledTask(args.scheduledTaskId);
}

/**
 * @requires ScheduledTaskClient
 */
export async function adminToggleScheduledTask(
  client: ScheduledTaskClient,
  args: { scheduledTaskId: string; enabled: boolean }
) {
  return args.enabled
    ? client.enableScheduledTask(args.scheduledTaskId)
    : client.disableScheduledTask(args.scheduledTaskId);
}
