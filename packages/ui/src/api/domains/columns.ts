import { request } from "../transport.js";
import type { Task } from "../../types/index.js";

export const columnsApi = {
  create: (
    boardId: string,
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
    request<{ column: import("../../types/index.js").Column }>(`/habitats/${boardId}/columns`, {
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
    request<{ column: import("../../types/index.js").Column }>(`/columns/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/columns/${id}`, { method: "DELETE" }),
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
