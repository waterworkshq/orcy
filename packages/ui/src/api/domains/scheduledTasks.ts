import { request } from "../transport.js";
import type { ScheduledTask, TaskTemplateEntry } from "../../types/index.js";

export const scheduledTasksApi = {
  list: (boardId: string) =>
    request<{ scheduledTasks: ScheduledTask[] }>(`/habitats/${boardId}/scheduled-tasks`),
  get: (id: string) => request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${id}`),
  create: (
    boardId: string,
    data: {
      name: string;
      description?: string;
      templateId?: string | null;
      scheduleType: "once" | "interval" | "cron";
      cronExpression?: string | null;
      intervalMinutes?: number | null;
      scheduledAt?: string | null;
      timezone?: string;
      missionTitle: string;
      missionDescription?: string;
      missionPriority?: import("../../types/index.js").TaskPriority;
      missionLabels?: string[];
      missionDomain?: string | null;
      tasksTemplate?: TaskTemplateEntry[];
    },
  ) =>
    request<{ scheduledTask: ScheduledTask }>(`/habitats/${boardId}/scheduled-tasks`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      name?: string;
      description?: string;
      scheduleType?: "once" | "interval" | "cron";
      cronExpression?: string | null;
      intervalMinutes?: number | null;
      scheduledAt?: string | null;
      timezone?: string;
      missionTitle?: string;
      missionDescription?: string;
      missionPriority?: import("../../types/index.js").TaskPriority;
      missionLabels?: string[];
      missionDomain?: string | null;
      tasksTemplate?: TaskTemplateEntry[];
      enabled?: boolean;
    },
  ) =>
    request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/scheduled-tasks/${id}`, { method: "DELETE" }),
  run: (id: string) =>
    request<{ success: boolean; featureId?: string; error?: string }>(
      `/scheduled-tasks/${id}/run`,
      {
        method: "POST",
      },
    ),
  enable: (id: string) =>
    request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${id}/enable`, {
      method: "POST",
    }),
  disable: (id: string) =>
    request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${id}/disable`, {
      method: "POST",
    }),
};
