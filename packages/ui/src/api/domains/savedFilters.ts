import { request } from "../transport.js";
import type { SavedFilter } from "../../types/index.js";

export const savedFiltersApi = {
  list: (boardId: string) =>
    request<{ savedFilters: SavedFilter[] }>(`/habitats/${boardId}/saved-filters`).then(
      (r) => r.savedFilters,
    ),
  create: (boardId: string, data: { name: string; filterConfig: Record<string, unknown> }) =>
    request<{ savedFilter: SavedFilter }>(`/habitats/${boardId}/saved-filters`, {
      method: "POST",
      body: JSON.stringify(data),
    }).then((r) => r.savedFilter),
  delete: (id: string) =>
    request<{ success: boolean }>(`/saved-filters/${id}`, { method: "DELETE" }),
};
