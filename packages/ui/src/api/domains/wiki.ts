import { request } from "../transport.js";
import type {
  WikiPage,
  WikiPageWithLinks,
  WikiPageStatus,
  WikiPageVersion,
  WikiPageLinkWithDangling,
  WikiLinkTargetType,
  WikiSearchHit,
  WikiCadence,
  WikiSignalSurface,
} from "../../types/index.js";

export const wikiApi = {
  listPages: (
    habitatId: string,
    filters?: { parentId?: string | null; tag?: string; status?: WikiPageStatus },
  ) => {
    const params = new URLSearchParams();
    if (filters?.parentId !== undefined && filters.parentId !== null)
      params.set("parentId", filters.parentId);
    if (filters?.tag) params.set("tag", filters.tag);
    if (filters?.status) params.set("status", filters.status);
    const qs = params.toString();
    return request<{ pages: WikiPage[] }>(
      `/habitats/${habitatId}/wiki/pages${qs ? `?${qs}` : ""}`,
    ).then((r) => r.pages);
  },
  getPage: (habitatId: string, pageId: string) =>
    request<{ page: WikiPageWithLinks }>(`/habitats/${habitatId}/wiki/pages/${pageId}`).then(
      (r) => r.page,
    ),
  createPage: (
    habitatId: string,
    body: {
      title: string;
      content: string;
      parentId?: string | null;
      tags?: string[];
      status?: WikiPageStatus;
      coverageFrom?: string;
      coverageTo?: string;
    },
  ) =>
    request<{ page: WikiPage }>(`/habitats/${habitatId}/wiki/pages`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.page),
  updatePageMetadata: (
    habitatId: string,
    pageId: string,
    patch: {
      parentId?: string | null;
      tags?: string[];
      status?: WikiPageStatus;
      coverageFrom?: string;
      coverageTo?: string;
    },
  ) =>
    request<{ page: WikiPage }>(`/habitats/${habitatId}/wiki/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }).then((r) => r.page),
  deletePage: (habitatId: string, pageId: string, opts?: { stayGone?: boolean; reason?: string }) =>
    request<{ success: boolean }>(`/habitats/${habitatId}/wiki/pages/${pageId}`, {
      method: "DELETE",
      body: JSON.stringify(opts ?? {}),
    }),

  listVersions: (habitatId: string, pageId: string) =>
    request<{ versions: WikiPageVersion[] }>(
      `/habitats/${habitatId}/wiki/pages/${pageId}/versions`,
    ).then((r) => r.versions),
  getVersion: (habitatId: string, pageId: string, n: number) =>
    request<{ version: WikiPageVersion }>(
      `/habitats/${habitatId}/wiki/pages/${pageId}/versions/${n}`,
    ).then((r) => r.version),
  saveVersion: (
    habitatId: string,
    pageId: string,
    body: { title: string; content: string; editSummary?: string },
  ) =>
    request<{ page: WikiPage }>(`/habitats/${habitatId}/wiki/pages/${pageId}/versions`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.page),
  restoreVersion: (habitatId: string, pageId: string, n: number) =>
    request<{ page: WikiPage }>(
      `/habitats/${habitatId}/wiki/pages/${pageId}/versions/${n}/restore`,
      { method: "POST" },
    ).then((r) => r.page),

  listLinks: (habitatId: string, pageId: string) =>
    request<{ links: WikiPageLinkWithDangling[] }>(
      `/habitats/${habitatId}/wiki/pages/${pageId}/links`,
    ).then((r) => r.links),
  addLink: (
    habitatId: string,
    pageId: string,
    body: { targetType: WikiLinkTargetType; targetId: string; note?: string },
  ) =>
    request<{ link: WikiPageLinkWithDangling }>(
      `/habitats/${habitatId}/wiki/pages/${pageId}/links`,
      { method: "POST", body: JSON.stringify(body) },
    ).then((r) => r.link),
  removeLink: (habitatId: string, pageId: string, linkId: string) =>
    request<{ success: boolean }>(`/habitats/${habitatId}/wiki/pages/${pageId}/links/${linkId}`, {
      method: "DELETE",
    }),

  search: (habitatId: string, q: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams({ q });
    params.set("limit", String(opts?.limit ?? 20));
    params.set("offset", String(opts?.offset ?? 0));
    return request<{ results: WikiSearchHit[] }>(
      `/habitats/${habitatId}/wiki/search?${params.toString()}`,
    ).then((r) => r.results);
  },

  markNoUpdateNeeded: (habitatId: string, body: { from: string; to: string; reason?: string }) =>
    request<{ marker: unknown }>(`/habitats/${habitatId}/wiki/coverage/no-update-needed`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getAuthoringContextForEdit: (habitatId: string, pageId: string) =>
    request<{ context: Record<string, unknown> }>(
      `/habitats/${habitatId}/wiki/pages/${pageId}/authoring-context`,
    ).then((r) => r.context),
  getAuthoringContextForChunk: (
    habitatId: string,
    body: { from?: string; to?: string; query?: string },
  ) =>
    request<{ context: Record<string, unknown> }>(`/habitats/${habitatId}/wiki/authoring-context`, {
      method: "POST",
      body: JSON.stringify(body),
    }).then((r) => r.context),

  getCadence: (habitatId: string) =>
    request<{ cadence: WikiCadence }>(`/habitats/${habitatId}/wiki/cadence`).then((r) => r.cadence),
  setCadence: (
    habitatId: string,
    body: {
      enabled?: boolean;
      scheduleType?: "interval" | "cron";
      intervalMinutes?: number;
      cronExpression?: string;
      timezone?: string;
    },
  ) =>
    request<{ cadence: WikiCadence }>(`/habitats/${habitatId}/wiki/cadence`, {
      method: "PUT",
      body: JSON.stringify(body),
    }).then((r) => r.cadence),
  disableCadence: (habitatId: string) =>
    request<{ success: boolean }>(`/habitats/${habitatId}/wiki/cadence`, { method: "DELETE" }),
  bootstrap: (habitatId: string) =>
    request<Record<string, unknown>>(`/habitats/${habitatId}/wiki/bootstrap`, {
      method: "POST",
    }),
  refresh: (habitatId: string) =>
    request<Record<string, unknown>>(`/habitats/${habitatId}/wiki/refresh`, { method: "POST" }),

  getSignalSurface: (
    habitatId: string,
    opts?: {
      domain?: string;
      timeWindow?: string;
      signalClass?: "experience" | "finding" | "both" | "detected";
    },
  ) => {
    const params = new URLSearchParams();
    if (opts?.domain) params.set("domain", opts.domain);
    if (opts?.timeWindow) params.set("timeWindow", opts.timeWindow);
    params.set("signalClass", opts?.signalClass ?? "both");
    return request<WikiSignalSurface>(
      `/habitats/${habitatId}/wiki/signal-surface?${params.toString()}`,
    );
  },
};
