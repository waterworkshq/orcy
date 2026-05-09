import { getEnabledIntegrationsByBoard } from '../repositories/chatIntegration.js';
import { getTaskById, getTasksByBoardId, getBoardIdForTask } from '../repositories/task.js';
import { getAgentById } from '../repositories/agent.js';
import { approveTask, rejectTask } from '../repositories/task.js';
import { formatSlackMessage, formatSlackTaskList, formatSlackTaskInfo, formatSlackHelp, formatSlackResponse, sendToSlack } from './slackService.js';
import { formatDiscordMessage, formatDiscordTaskList, formatDiscordTaskInfo, formatDiscordHelp, formatDiscordResponse, sendToDiscord } from './discordService.js';
import { validateOutboundUrl } from '../config/integrationSecurity.js';
import { logger } from '../lib/logger.js';

const EVENT_TYPE_MAP: Record<string, string> = {
  'task.created': 'task_created',
  'task.claimed': 'task_claimed',
  'task.submitted': 'task_submitted',
  'task.approved': 'task_approved',
  'task.rejected': 'task_rejected',
  'task.overdue': 'task_overdue',
};

export async function processEvent(eventType: string, boardId: string, data: Record<string, unknown>): Promise<void> {
  const mappedEvent = EVENT_TYPE_MAP[eventType];
  if (!mappedEvent) return;

  const integrations = getEnabledIntegrationsByBoard(boardId);
  if (integrations.length === 0) return;

  let taskId: string | undefined;
  if ('taskId' in data) taskId = data.taskId as string;
  if ('id' in data) taskId = data.id as string;

  const task = taskId ? getTaskById(taskId) : undefined;
  let assignedAgentName: string | undefined;
  if (task?.assignedAgentId) {
    const agent = getAgentById(task.assignedAgentId);
    assignedAgentName = agent?.name;
  }

  const taskData = task ? {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignedAgentName,
  } : undefined;

  for (const integration of integrations) {
    if (integration.events.length > 0 && !integration.events.includes(mappedEvent)) continue;

    try {
      if (integration.provider === 'slack') {
        const message = formatSlackMessage(mappedEvent, taskData);
        await sendToSlack(integration.webhookUrl, message);
      } else {
        const message = formatDiscordMessage(mappedEvent, taskData);
        await sendToDiscord(integration.webhookUrl, message);
      }
    } catch (err) {
      logger.error({ err, integrationId: integration.id }, 'Chat push error');
    }
  }
}

export async function executeCommand(
  boardId: string,
  action: string,
  args: string[],
  _userId?: string
): Promise<{ response: object; provider: 'slack' | 'discord' }> {
  switch (action) {
    case 'list':
    case 'tasks': {
      const { tasks } = getTasksByBoardId(boardId, { status: 'pending', limit: 10 });
      return {
        response: { slack: formatSlackTaskList(tasks), discord: formatDiscordTaskList(tasks) },
        provider: 'slack',
      };
    }

    case 'info': {
      const taskId = args[0];
      if (!taskId) {
        return {
          response: {
            slack: formatSlackResponse('Usage: /orcy info <task-id>', false),
            discord: formatDiscordResponse('Usage: /orcy info <task-id>', false),
          },
          provider: 'slack',
        };
      }
      const task = findTask(boardId, taskId);
      if (!task) {
        return {
          response: {
            slack: formatSlackResponse(`Task not found: ${taskId}`, false),
            discord: formatDiscordResponse(`Task not found: ${taskId}`, false),
          },
          provider: 'slack',
        };
      }
      let assignedAgentName: string | undefined;
      if (task.assignedAgentId) {
        const agent = getAgentById(task.assignedAgentId);
        assignedAgentName = agent?.name;
      }
      const taskInfo = { id: task.id, title: task.title, status: task.status, priority: task.priority, description: task.description, assignedAgentName };
      return {
        response: { slack: formatSlackTaskInfo(taskInfo), discord: formatDiscordTaskInfo(taskInfo) },
        provider: 'slack',
      };
    }

    case 'approve': {
      const taskId = args[0];
      if (!taskId) {
        return {
          response: {
            slack: formatSlackResponse('Usage: /orcy approve <task-id>', false),
            discord: formatDiscordResponse('Usage: /orcy approve <task-id>', false),
          },
          provider: 'slack',
        };
      }
      const task = findTask(boardId, taskId);
      if (!task) {
        return {
          response: {
            slack: formatSlackResponse(`Task not found: ${taskId}`, false),
            discord: formatDiscordResponse(`Task not found: ${taskId}`, false),
          },
          provider: 'slack',
        };
      }
      const result = approveTask(task.id);
      if (!result) {
        return {
          response: {
            slack: formatSlackResponse(`Task "${task.title}" is not in submitted status`, false),
            discord: formatDiscordResponse(`Task "${task.title}" is not in submitted status`, false),
          },
          provider: 'slack',
        };
      }
      return {
        response: {
          slack: formatSlackResponse(`Task "${task.title}" approved`, true),
          discord: formatDiscordResponse(`Task "${task.title}" approved`, true),
        },
        provider: 'slack',
      };
    }

    case 'reject': {
      const taskId = args[0];
      const reason = args.slice(1).join(' ') || 'Rejected via chat command';
      if (!taskId) {
        return {
          response: {
            slack: formatSlackResponse('Usage: /orcy reject <task-id> [reason]', false),
            discord: formatDiscordResponse('Usage: /orcy reject <task-id> [reason]', false),
          },
          provider: 'slack',
        };
      }
      const task = findTask(boardId, taskId);
      if (!task) {
        return {
          response: {
            slack: formatSlackResponse(`Task not found: ${taskId}`, false),
            discord: formatDiscordResponse(`Task not found: ${taskId}`, false),
          },
          provider: 'slack',
        };
      }
      const result = rejectTask(task.id, reason);
      if (!result) {
        return {
          response: {
            slack: formatSlackResponse(`Task "${task.title}" is not in submitted status`, false),
            discord: formatDiscordResponse(`Task "${task.title}" is not in submitted status`, false),
          },
          provider: 'slack',
        };
      }
      return {
        response: {
          slack: formatSlackResponse(`Task "${task.title}" rejected: ${reason}`, true),
          discord: formatDiscordResponse(`Task "${task.title}" rejected: ${reason}`, true),
        },
        provider: 'slack',
      };
    }

    case 'help': {
      return {
        response: { slack: formatSlackHelp(), discord: formatDiscordHelp() },
        provider: 'slack',
      };
    }

    default:
      return {
        response: {
          slack: formatSlackResponse(`Unknown command: ${action}. Type /orcy help for available commands.`, false),
          discord: formatDiscordResponse(`Unknown command: ${action}. Type /orcy help for available commands.`, false),
        },
        provider: 'slack',
      };
  }
}

function findTask(boardId: string, taskIdOrShort: string): ReturnType<typeof getTaskById> {
  const task = getTaskById(taskIdOrShort);
  if (task) {
    const taskBoardId = getBoardIdForTask(task.id);
    if (taskBoardId === boardId) return task;
  }

  const { tasks } = getTasksByBoardId(boardId);
  return tasks.find(t => t.id.startsWith(taskIdOrShort)) ?? null;
}

export async function sendAnomalyAlert(
  boardId: string,
  anomaly: { type: string; severity: string; message: string; data: Record<string, unknown> },
): Promise<void> {
  const integrations = getEnabledIntegrationsByBoard(boardId);
  if (integrations.length === 0) return;

  const severityEmoji: Record<string, string> = {
    low: '\u2139\uFE0F',
    medium: '\u26A0\uFE0F',
    high: '\uD83D\uDD34',
    critical: '\uD83D\uDEA8',
  };
  const emoji = severityEmoji[anomaly.severity] || '🐋';
  const title = anomaly.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  for (const integration of integrations) {
    try {
      if (integration.provider === 'slack') {
        const message = {
          text: `[Orcy] ${emoji} ${title}: ${anomaly.message}`,
          blocks: [
            {
              type: 'header',
              text: {
                type: 'plain_text',
                text: `${emoji} ${title} (${anomaly.severity.toUpperCase()})`,
              },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: anomaly.message },
            },
          ],
        };
        await sendToSlack(integration.webhookUrl, message);
      } else {
        const color =
          anomaly.severity === 'critical'
            ? 15548997
            : anomaly.severity === 'high'
              ? 16711680
              : anomaly.severity === 'medium'
                ? 16776960
                : 3447003;
        const message = {
          content: `${emoji} ${title}`,
          embeds: [
            {
              title: `${emoji} ${title} (${anomaly.severity.toUpperCase()})`,
              description: anomaly.message,
              color,
              timestamp: new Date().toISOString(),
            },
          ],
        };
        await sendToDiscord(integration.webhookUrl, message);
      }
    } catch (err) {
      logger.error({ err, integrationId: integration.id }, 'Anomaly chat push error');
    }
  }
}

export async function sendTestMessage(
  webhookUrl: string,
  provider: 'slack' | 'discord'
): Promise<{ success: boolean; statusCode: number; latencyMs: number }> {
  const urlValidation = await validateOutboundUrl(webhookUrl);
  if (!urlValidation.valid) {
    return { success: false, statusCode: 0, latencyMs: 0 };
  }

  const startTime = Date.now();
  let success: boolean;

  if (provider === 'slack') {
    const message = formatSlackMessage('task_created', {
      id: 'test-task',
      title: 'Test Task (Chat Integration)',
      status: 'pending',
      priority: 'medium',
    });
    success = await sendToSlack(webhookUrl, message);
  } else {
    const message = formatDiscordMessage('task_created', {
      id: 'test-task',
      title: 'Test Task (Chat Integration)',
      status: 'pending',
      priority: 'medium',
    });
    success = await sendToDiscord(webhookUrl, message);
  }

  return {
    success,
    statusCode: success ? 200 : 0,
    latencyMs: Date.now() - startTime,
  };
}
