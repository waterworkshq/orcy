import { verifySlackSignature, validateOutboundUrl } from '../config/integrationSecurity.js';
import { logger } from '../lib/logger.js';

export function verifySlackRequest(signature: string | undefined, body: string, signingSecret: string): boolean {
  const result = verifySlackSignature(signature, undefined, body, signingSecret);
  return result.valid;
}

export function verifySlackRequestWithTimestamp(
  signature: string | undefined,
  timestamp: string | undefined,
  body: string,
  signingSecret: string,
): { valid: boolean; reason?: string } {
  return verifySlackSignature(signature, timestamp, body, signingSecret);
}

export interface ParsedCommand {
  action: string;
  args: string[];
}

export function parseSlackCommand(text: string): ParsedCommand {
  const parts = text.trim().split(/\s+/);
  const action = (parts[0] || 'help').toLowerCase();
  const args = parts.slice(1);
  return { action, args };
}

interface TaskData {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignedAgentName?: string;
}

export function formatSlackMessage(eventType: string, taskData?: TaskData): object {
  const eventEmoji: Record<string, string> = {
    'task_created': '🆕',
    'task_claimed': '🤚',
    'task_submitted': '📨',
    'task_approved': '✅',
    'task_rejected': '❌',
    'task_overdue': '⚠️',
  };

  const emoji = eventEmoji[eventType] || '🐋';
  const title = eventType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} ${title}` },
    },
  ];

  if (taskData) {
    const fields: Array<{ type: string; text: string }> = [
      { type: 'mrkdwn', text: `*Task:*\n${taskData.title}` },
      { type: 'mrkdwn', text: `*Priority:*\n${taskData.priority}` },
      { type: 'mrkdwn', text: `*Status:*\n${taskData.status}` },
    ];
    if (taskData.assignedAgentName) {
      fields.push({ type: 'mrkdwn', text: `*Agent:*\n${taskData.assignedAgentName}` });
    }
    blocks.push({
      type: 'section',
      fields,
    });
  }

  return { text: `[Orcy] ${title}: ${taskData?.title || ''}`, blocks };
}

export function formatSlackTaskList(tasks: Array<{ id: string; title: string; status: string; priority: string }>): object {
  if (tasks.length === 0) {
    return {
      text: 'No pending tasks found.',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '⚡ *No pending tasks found.*' } },
      ],
    };
  }

  const lines = tasks.slice(0, 10).map(t =>
    `• *${t.title}* [${t.id.substring(0, 8)}] — ${t.status} · ${t.priority}`
  );

  return {
    text: `Pending tasks (${tasks.length})`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `⚡ Pending Tasks (${tasks.length})` } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      ...(tasks.length > 10 ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `_Showing 10 of ${tasks.length} tasks_` }] }] : []),
    ],
  };
}

export function formatSlackTaskInfo(task: { id: string; title: string; status: string; priority: string; description?: string; assignedAgentName?: string }): object {
  const fields: Array<{ type: string; text: string }> = [
    { type: 'mrkdwn', text: `*ID:* ${task.id.substring(0, 8)}` },
    { type: 'mrkdwn', text: `*Status:* ${task.status}` },
    { type: 'mrkdwn', text: `*Priority:* ${task.priority}` },
  ];
  if (task.assignedAgentName) {
    fields.push({ type: 'mrkdwn', text: `*Agent:* ${task.assignedAgentName}` });
  }

  return {
    text: `Task: ${task.title}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `⚡ ${task.title}` } },
      { type: 'section', fields },
      ...(task.description ? [{ type: 'section', text: { type: 'mrkdwn', text: task.description.substring(0, 500) } }] : []),
    ],
  };
}

export function formatSlackHelp(): object {
  return {
    text: 'Available commands',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🤖 Orcy Commands' } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '`/orcy list` — List pending tasks',
            '`/orcy claim T-123` — Claim a task',
            '`/orcy submit T-123` — Submit a task for review',
            '`/orcy approve T-123` — Approve a task',
            '`/orcy reject T-123 [reason]` — Reject a task',
            '`/orcy info T-123` — Show task details',
            '`/orcy help` — Show this help message',
          ].join('\n'),
        },
      },
    ],
  };
}

export function formatSlackResponse(message: string, success: boolean): object {
  return {
    text: message,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${success ? '✅' : '❌'} ${message}`,
        },
      },
    ],
  };
}

export async function sendToSlack(webhookUrl: string, message: object): Promise<boolean> {
  const urlValidation = await validateOutboundUrl(webhookUrl);
  if (!urlValidation.valid) {
    logger.warn({ reason: urlValidation.reason }, 'Blocked outbound Slack webhook');
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}
