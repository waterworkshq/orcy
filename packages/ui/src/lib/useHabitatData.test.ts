import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import {
  useTemplates,
  useChatIntegrations,
  useNotificationPrefs,
  useScheduledTasks,
  useArchivedMissionsInfinite,
} from "./useHabitatData.js";

vi.mock("../api/index.js", () => ({
  api: {
    templates: {
      list: vi.fn().mockResolvedValue({ templates: [{ id: "t1", name: "Template 1" }] }),
    },
    chatIntegrations: {
      list: vi.fn().mockResolvedValue([{ id: "ci1", provider: "slack" }]),
    },
    notifications: {
      getGlobalPrefs: vi.fn().mockResolvedValue({ preferences: { email: true }, email: "a@b.c" }),
      getHabitatPrefs: vi.fn().mockResolvedValue({ preferences: { slack: true } }),
    },
    scheduledTasks: {
      list: vi.fn().mockResolvedValue({ scheduledTasks: [{ id: "st1", name: "Daily" }] }),
    },
    missions: {
      list: vi.fn().mockResolvedValue({ features: [{ id: "f1", title: "Archived" }], total: 1 }),
    },
  },
}));

import { api } from "../api/index.js";

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useTemplates", () => {
  it("fetches data when habitatId is provided", async () => {
    const { result } = renderHook(() => useTemplates("board-1"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.templates.list).toHaveBeenCalledWith("board-1");
    expect(result.current.data).toEqual({ templates: [{ id: "t1", name: "Template 1" }] });
  });

  it("is disabled when habitatId is undefined", () => {
    const { result } = renderHook(() => useTemplates(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.templates.list).not.toHaveBeenCalled();
  });
});

describe("useChatIntegrations", () => {
  it("fetches data when habitatId is provided", async () => {
    const { result } = renderHook(() => useChatIntegrations("board-1"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.chatIntegrations.list).toHaveBeenCalledWith("board-1");
    expect(result.current.data).toEqual([{ id: "ci1", provider: "slack" }]);
  });

  it("is disabled when habitatId is undefined", () => {
    const { result } = renderHook(() => useChatIntegrations(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.chatIntegrations.list).not.toHaveBeenCalled();
  });
});

describe("useNotificationPrefs", () => {
  it("fetches global and board prefs in parallel", async () => {
    const { result } = renderHook(() => useNotificationPrefs("board-1"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.notifications.getGlobalPrefs).toHaveBeenCalled();
    expect(api.notifications.getHabitatPrefs).toHaveBeenCalledWith("board-1");
    expect(result.current.data).toEqual({
      global: { preferences: { email: true }, email: "a@b.c" },
      board: { preferences: { slack: true } },
    });
  });

  it("is disabled when habitatId is undefined", () => {
    const { result } = renderHook(() => useNotificationPrefs(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.notifications.getGlobalPrefs).not.toHaveBeenCalled();
    expect(api.notifications.getHabitatPrefs).not.toHaveBeenCalled();
  });
});

describe("useScheduledTasks", () => {
  it("fetches data when habitatId is provided", async () => {
    const { result } = renderHook(() => useScheduledTasks("board-1"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.scheduledTasks.list).toHaveBeenCalledWith("board-1");
    expect(result.current.data).toEqual({ scheduledTasks: [{ id: "st1", name: "Daily" }] });
  });

  it("is disabled when habitatId is undefined", () => {
    const { result } = renderHook(() => useScheduledTasks(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.scheduledTasks.list).not.toHaveBeenCalled();
  });
});

describe("useArchivedMissionsInfinite", () => {
  it("passes { isArchived: true, limit, offset: 0 } and exposes hasNextPage", async () => {
    api.missions.list = vi.fn().mockResolvedValue({
      missions: [{ id: "f1", title: "Archived" }],
      total: 30,
    });
    const { result } = renderHook(() => useArchivedMissionsInfinite("habitat-1"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.missions.list).toHaveBeenCalledWith(
      "habitat-1",
      expect.objectContaining({ isArchived: true, limit: 50, offset: 0 }),
      expect.anything(),
    );
    expect(result.current.hasNextPage).toBe(true);
    expect(result.current.data?.pages[0].missions).toHaveLength(1);
  });

  it("reports no next page when raw accumulated count reaches total", async () => {
    api.missions.list = vi.fn().mockResolvedValue({
      missions: [{ id: "f1" }, { id: "f2" }],
      total: 2,
    });
    const { result } = renderHook(() => useArchivedMissionsInfinite("habitat-1"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });

  it("is disabled when habitatId is undefined", () => {
    const { result } = renderHook(() => useArchivedMissionsInfinite(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.missions.list).not.toHaveBeenCalled();
  });
});
