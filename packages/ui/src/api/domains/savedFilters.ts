import { request } from "../transport.js";
import type { SavedFilter } from "../../types/index.js";

export const savedFiltersApi = {
  list: (habitatId: string) =>
    request<{ savedFilters: SavedFilter[] }>(`/habitats/${habitatId}/saved-filters`).then(
      (r) => r.savedFilters,
    ),
  create: (habitatId: string, data: { name: string; filterConfig: Record<string, unknown> }) =>
    request<{ savedFilter: SavedFilter }>(`/habitats/${habitatId}/saved-filters`, {
      method: "POST",
      body: JSON.stringify(data),
    }).then((r) => r.savedFilter),
  delete: (id: string) =>
    request<{ success: boolean }>(`/saved-filters/${id}`, { method: "DELETE" }),
};
