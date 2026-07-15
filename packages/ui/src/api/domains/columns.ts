import { request } from "../transport.js";
import type { Task, Column } from "../../types/index.js";

export const columnsApi = {
  create: (
    habitatId: string,
    data: {
      name: string;
      order?: number;
      wipLimit?: number | null;
      autoAdvance?: boolean;
      requiresClaim?: boolean;
      nextColumnId?: string | null;
      isTerminal?: boolean;
    },
  ) =>
    request<{ column: Column }>(`/habitats/${habitatId}/columns`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      name?: string;
      order?: number;
      wipLimit?: number | null;
      autoAdvance?: boolean;
      requiresClaim?: boolean;
      nextColumnId?: string | null;
      isTerminal?: boolean;
    },
  ) =>
    request<{ column: Column }>(`/columns/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/columns/${id}`, { method: "DELETE" }),
  reorder: (habitatId: string, data: { expectedOrder: string[]; desiredOrder: string[] }) =>
    request<{ columns: Column[] }>(`/habitats/${habitatId}/columns/reorder`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  reorderTask: (
    columnId: string,
    data: {
      taskId: string;
      afterTaskId?: string | null;
      beforeTaskId?: string | null;
    },
  ) =>
    request<{ task: Task }>(`/columns/${columnId}/tasks/reorder`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
};
