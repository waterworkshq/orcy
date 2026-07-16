import { request } from "../transport.js";
import type { MissionTemplate, TaskPriority, TaskTemplateEntry } from "../../types/index.js";

export const templatesApi = {
  list: (habitatId: string) =>
    request<{ templates: MissionTemplate[] }>(`/habitats/${habitatId}/templates`),
  create: (
    habitatId: string,
    data: {
      name: string;
      titlePattern: string;
      descriptionPattern?: string;
      priority?: TaskPriority;
      labels?: string[];
      requiredDomain?: string | null;
      requiredCapabilities?: string[];
      tasksTemplate?: TaskTemplateEntry[];
      workflowTemplate?: unknown;
    },
  ) =>
    request<{ template: MissionTemplate }>(`/habitats/${habitatId}/templates`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      name?: string;
      titlePattern?: string;
      descriptionPattern?: string;
      priority?: TaskPriority;
      labels?: string[];
      requiredDomain?: string | null;
      requiredCapabilities?: string[];
      tasksTemplate?: TaskTemplateEntry[];
      workflowTemplate?: unknown;
    },
  ) =>
    request<{ template: MissionTemplate }>(`/templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/templates/${id}`, { method: "DELETE" }),
  recordUsage: (id: string) =>
    request<{ success: boolean }>(`/templates/${id}/usage`, { method: "POST" }),
};
