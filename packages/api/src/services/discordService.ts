import { verifyDiscordSignature, validateOutboundUrl } from '../config/integrationSecurity.js';
import { logger } from '../lib/logger.js';

export function verifyDiscordRequest(signature: string | undefined, timestamp: string | undefined, body: string, publicKey: string): boolean {
  return verifyDiscordSignature(signature, timestamp, body, publicKey);
}

export interface ParsedCommand {
  action: string;
  args: string[];
}

export function parseDiscordCommand(data: { name?: string; options?: Array<{ name: string; value: string; options?: Array<{ name: string; value: string }> }> }): ParsedCommand {
  if (data.name === 'orcy' && data.options && data.options.length > 0) {
    const subcommand = data.options[0];
    const action = subcommand.name.toLowerCase();
    const args: string[] = [];
    if (subcommand.options) {
      for (const opt of subcommand.options) {
        args.push(String(opt.value));
      }
    }
    return { action, args };
  }
  return { action: 'help', args: [] };
}

interface TaskData {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignedAgentName?: string;
}

export function formatDiscordMessage(eventType: string, taskData?: TaskData): object {
  const colorMap: Record<string, number> = {
    'task_created': 3447003,
    'task_claimed': 16776960,
    'task_submitted': 5763719,
    'task_approved': 5763719,
    'task_rejected': 15548997,
    'task_overdue': 15548997,
  };

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
  const color = colorMap[eventType] || 5763719;

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (taskData) {
    fields.push({ name: 'Task', value: taskData.title, inline: true });
    fields.push({ name: 'Priority', value: taskData.priority, inline: true });
    fields.push({ name: 'Status', value: taskData.status, inline: true });
    if (taskData.assignedAgentName) {
      fields.push({ name: 'Agent', value: taskData.assignedAgentName, inline: true });
    }
  }

  return {
    content: `${emoji} ${title}`,
    embeds: [{
      title: `${emoji} ${title}`,
      color,
      fields,
      timestamp: new Date().toISOString(),
    }],
  };
}

export function formatDiscordTaskList(tasks: Array<{ id: string; title: string; status: string; priority: string }>): object {
  if (tasks.length === 0) {
    return {
      content: '⚡ No pending tasks found.',
      embeds: [{
        title: '⚡ Pending Tasks',
        description: 'No pending tasks found.',
        color: 5763719,
      }],
    };
  }

  const description = tasks.slice(0, 10).map(t =>
    `• **${t.title}** [\`${t.id.substring(0, 8)}\`] — ${t.status} · ${t.priority}`
  ).join('\n');

  return {
    content: `⚡ Pending Tasks (${tasks.length})`,
    embeds: [{
      title: `⚡ Pending Tasks (${tasks.length})`,
      description: description.substring(0, 4096),
      color: 5763719,
      ...(tasks.length > 10 ? { footer: { text: `Showing 10 of ${tasks.length} tasks` } } : {}),
    }],
  };
}

export function formatDiscordTaskInfo(task: { id: string; title: string; status: string; priority: string; description?: string; assignedAgentName?: string }): object {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: 'ID', value: `\`${task.id.substring(0, 8)}\``, inline: true },
    { name: 'Status', value: task.status, inline: true },
    { name: 'Priority', value: task.priority, inline: true },
  ];
  if (task.assignedAgentName) {
    fields.push({ name: 'Agent', value: task.assignedAgentName, inline: true });
  }

  return {
    content: `⚡ ${task.title}`,
    embeds: [{
      title: `⚡ ${task.title}`,
      fields,
      ...(task.description ? { description: task.description.substring(0, 500) } : {}),
      color: 5763719,
    }],
  };
}

export function formatDiscordHelp(): object {
  return {
    content: '🤖 Orcy Commands',
    embeds: [{
      title: '🤖 Orcy Commands',
      description: [
        '`/orcy list` — List pending tasks',
        '`/orcy claim T-123` — Claim a task',
        '`/orcy submit T-123` — Submit a task for review',
        '`/orcy approve T-123` — Approve a task',
        '`/orcy reject T-123 [reason]` — Reject a task',
        '`/orcy info T-123` — Show task details',
        '`/orcy help` — Show this help message',
      ].join('\n'),
      color: 3447003,
    }],
  };
}

export function formatDiscordResponse(message: string, success: boolean): object {
  return {
    content: `${success ? '✅' : '❌'} ${message}`,
    embeds: [{
      description: message,
      color: success ? 5763719 : 15548997,
    }],
  };
}

export async function sendToDiscord(webhookUrl: string, message: object): Promise<boolean> {
  const urlValidation = await validateOutboundUrl(webhookUrl);
  if (!urlValidation.valid) {
    logger.warn({ reason: urlValidation.reason }, 'Blocked outbound Discord webhook');
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
