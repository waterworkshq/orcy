import { getEnabledIntegrationsByHabitat } from "../repositories/chatIntegration.js";
import { getTaskById, getTasksByHabitatId, getHabitatIdForTask } from "../repositories/task.js";
import { getAgentById } from "../repositories/agent.js";
import {
  formatSlackMessage,
  formatSlackTaskList,
  formatSlackTaskInfo,
  formatSlackHelp,
  formatSlackResponse,
  sendToSlack,
} from "./slackService.js";
import {
  formatDiscordMessage,
  formatDiscordTaskList,
  formatDiscordTaskInfo,
  formatDiscordHelp,
  formatDiscordResponse,
  sendToDiscord,
} from "./discordService.js";
import { validateOutboundUrl } from "../config/integrationSecurity.js";
import { logger } from "../lib/logger.js";

const EVENT_TYPE_MAP: Record<string, string> = {
  "task.created": "task_created",
  "task.claimed": "task_claimed",
  "task.submitted": "task_submitted",
  "task.approved": "task_approved",
  "task.rejected": "task_rejected",
  "task.overdue": "task_overdue",
};

/** Pushes a task lifecycle event to all enabled chat integrations for the habitat. Maps internal event names to integration events and dispatches Slack or Discord messages. */
export async function processEvent(
  eventType: string,
  habitatId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const mappedEvent = EVENT_TYPE_MAP[eventType];
  if (!mappedEvent) return;

  const integrations = getEnabledIntegrationsByHabitat(habitatId);
  if (integrations.length === 0) return;

  let taskId: string | undefined;
  if ("taskId" in data) taskId = data.taskId as string;
  if ("id" in data) taskId = data.id as string;

  const task = taskId ? getTaskById(taskId) : undefined;
  let assignedAgentName: string | undefined;
  if (task?.assignedAgentId) {
    const agent = getAgentById(task.assignedAgentId);
    assignedAgentName = agent?.name;
  }

  const taskData = task
    ? {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        assignedAgentName,
      }
    : undefined;

  for (const integration of integrations) {
    if (integration.events.length > 0 && !integration.events.includes(mappedEvent)) continue;

    try {
      if (integration.provider === "slack") {
        const message = formatSlackMessage(mappedEvent, taskData);
        await sendToSlack(integration.webhookUrl, message);
      } else {
        const message = formatDiscordMessage(mappedEvent, taskData);
        await sendToDiscord(integration.webhookUrl, message);
      }
    } catch (err) {
      logger.error({ err, integrationId: integration.id }, "Chat push error");
    }
  }
}

/** Runs a read-only slash-command action (`list`, `info`, `help`) against tasks in the habitat and returns formatted payloads for both Slack and Discord. Review decisions (`approve`/`reject`) are NOT handled here: they route through the mapped-local-human decision path (`chatReviewDecision.ts`) — the former repository-layer bypass (state write with no event, no retry ladder, no reviewer semantics) is closed. */
export async function executeCommand(
  habitatId: string,
  action: string,
  args: string[],
): Promise<{ response: object; provider: "slack" | "discord" }> {
  switch (action) {
    case "list":
    case "tasks": {
      const { tasks } = getTasksByHabitatId(habitatId, { status: "pending", limit: 10 });
      return {
        response: { slack: formatSlackTaskList(tasks), discord: formatDiscordTaskList(tasks) },
        provider: "slack",
      };
    }

    case "info": {
      const taskId = args[0];
      if (!taskId) {
        return {
          response: {
            slack: formatSlackResponse("Usage: /orcy info <task-id>", false),
            discord: formatDiscordResponse("Usage: /orcy info <task-id>", false),
          },
          provider: "slack",
        };
      }
      const task = findTask(habitatId, taskId);
      if (!task) {
        return {
          response: {
            slack: formatSlackResponse(`Task not found: ${taskId}`, false),
            discord: formatDiscordResponse(`Task not found: ${taskId}`, false),
          },
          provider: "slack",
        };
      }
      let assignedAgentName: string | undefined;
      if (task.assignedAgentId) {
        const agent = getAgentById(task.assignedAgentId);
        assignedAgentName = agent?.name;
      }
      const taskInfo = {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        description: task.description,
        assignedAgentName,
      };
      return {
        response: {
          slack: formatSlackTaskInfo(taskInfo),
          discord: formatDiscordTaskInfo(taskInfo),
        },
        provider: "slack",
      };
    }

    case "help": {
      return {
        response: { slack: formatSlackHelp(), discord: formatDiscordHelp() },
        provider: "slack",
      };
    }

    default:
      return {
        response: {
          slack: formatSlackResponse(
            `Unknown command: ${action}. Type /orcy help for available commands.`,
            false,
          ),
          discord: formatDiscordResponse(
            `Unknown command: ${action}. Type /orcy help for available commands.`,
            false,
          ),
        },
        provider: "slack",
      };
  }
}

export function findTask(habitatId: string, taskIdOrShort: string): ReturnType<typeof getTaskById> {
  const task = getTaskById(taskIdOrShort);
  if (task) {
    const taskHabitatId = getHabitatIdForTask(task.id);
    if (taskHabitatId === habitatId) return task;
  }

  const { tasks } = getTasksByHabitatId(habitatId);
  return tasks.find((t) => t.id.startsWith(taskIdOrShort)) ?? null;
}

/** Pushes an anomaly alert to all enabled chat integrations for the habitat, formatted with severity-based emoji and color. */
export async function sendAnomalyAlert(
  habitatId: string,
  anomaly: { type: string; severity: string; message: string; data: Record<string, unknown> },
): Promise<void> {
  const integrations = getEnabledIntegrationsByHabitat(habitatId);
  if (integrations.length === 0) return;

  const severityEmoji: Record<string, string> = {
    low: "\u2139\uFE0F",
    medium: "\u26A0\uFE0F",
    high: "\uD83D\uDD34",
    critical: "\uD83D\uDEA8",
  };
  const emoji = severityEmoji[anomaly.severity] || "🐋";
  const title = anomaly.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  for (const integration of integrations) {
    try {
      if (integration.provider === "slack") {
        const message = {
          text: `[Orcy] ${emoji} ${title}: ${anomaly.message}`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `${emoji} ${title} (${anomaly.severity.toUpperCase()})`,
              },
            },
            {
              type: "section",
              text: { type: "mrkdwn", text: anomaly.message },
            },
          ],
        };
        await sendToSlack(integration.webhookUrl, message);
      } else {
        const color =
          anomaly.severity === "critical"
            ? 15548997
            : anomaly.severity === "high"
              ? 16711680
              : anomaly.severity === "medium"
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
      logger.error({ err, integrationId: integration.id }, "Anomaly chat push error");
    }
  }
}

/** Sends a test message to a chat integration webhook and reports success, HTTP status code, and latency. Rejects URLs that fail outbound validation. */
export async function sendTestMessage(
  webhookUrl: string,
  provider: "slack" | "discord",
): Promise<{ success: boolean; statusCode: number; latencyMs: number }> {
  const urlValidation = await validateOutboundUrl(webhookUrl);
  if (!urlValidation.valid) {
    return { success: false, statusCode: 0, latencyMs: 0 };
  }

  const startTime = Date.now();
  let success: boolean;

  if (provider === "slack") {
    const message = formatSlackMessage("task_created", {
      id: "test-task",
      title: "Test Task (Chat Integration)",
      status: "pending",
      priority: "medium",
    });
    success = await sendToSlack(webhookUrl, message);
  } else {
    const message = formatDiscordMessage("task_created", {
      id: "test-task",
      title: "Test Task (Chat Integration)",
      status: "pending",
      priority: "medium",
    });
    success = await sendToDiscord(webhookUrl, message);
  }

  return {
    success,
    statusCode: success ? 200 : 0,
    latencyMs: Date.now() - startTime,
  };
}
