import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { presenceApi } from "../api/domains/presence.js";
import * as transport from "../api/transport.js";

vi.mock("../api/transport.js", async () => {
  const actual = await vi.importActual<typeof import("../api/transport.js")>(
    "../api/transport.js",
  );
  return {
    ...actual,
    request: vi.fn().mockResolvedValue({ success: true }),
  };
});

import { request } from "../api/transport.js";
const requestMock = vi.mocked(request);

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

function lastBody(): string {
  const call = requestMock.mock.calls.at(-1);
  if (!call) throw new Error("no request call captured");
  return call[1]?.body as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  requestMock.mockResolvedValue({ success: true });
});

describe("presenceApi body shape", () => {
  it("join sends the habitat id under the habitatId key, never boardId", async () => {
    await presenceApi.join({
      sessionId: "s1",
      type: "human",
      habitatId: "hab-1",
      userId: "u1",
      userName: "Alice",
    });

    expect(requestMock).toHaveBeenCalledWith(
      "/sse/presence/join",
      expect.objectContaining({ method: "POST" }),
    );
    const body = lastBody();
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ sessionId: "s1", type: "human", habitatId: "hab-1" });
    expect(parsed).not.toHaveProperty("boardId");
    expect(body).toContain("habitatId");
    expect(body).not.toContain("boardId");
  });

  it("heartbeat sends the habitat id under the habitatId key, never boardId", async () => {
    await presenceApi.heartbeat({ sessionId: "s1", habitatId: "hab-1" });

    expect(requestMock).toHaveBeenCalledWith(
      "/sse/presence/heartbeat",
      expect.objectContaining({ method: "POST" }),
    );
    const body = lastBody();
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ sessionId: "s1", habitatId: "hab-1" });
    expect(parsed).not.toHaveProperty("boardId");
    expect(body).toContain("habitatId");
    expect(body).not.toContain("boardId");
  });

  it("leave sends the habitat id under the habitatId key, never boardId", async () => {
    await presenceApi.leave({ sessionId: "s1", habitatId: "hab-1" });

    expect(requestMock).toHaveBeenCalledWith(
      "/sse/presence/leave",
      expect.objectContaining({ method: "POST" }),
    );
    const body = lastBody();
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ sessionId: "s1", habitatId: "hab-1" });
    expect(parsed).not.toHaveProperty("boardId");
    expect(body).toContain("habitatId");
    expect(body).not.toContain("boardId");
  });
});

describe("usePresence hook wires habitatId to presenceApi", () => {
  it("calls presenceApi.join and presenceApi.leave with habitatId (not boardId)", async () => {
    const { api } = await import("../api/index.js");
    const joinSpy = vi
      .spyOn(api.presence, "join")
      .mockResolvedValue({ success: true } as never);
    const heartbeatSpy = vi
      .spyOn(api.presence, "heartbeat")
      .mockResolvedValue({ success: true } as never);
    const leaveSpy = vi
      .spyOn(api.presence, "leave")
      .mockResolvedValue({ success: true } as never);

    const { unmount } = renderHook(() => usePresenceHook("hab-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(joinSpy).toHaveBeenCalled());
    expect(joinSpy.mock.calls[0][0]).toMatchObject({ habitatId: "hab-1" });
    expect(joinSpy.mock.calls[0][0]).not.toHaveProperty("boardId");

    expect(heartbeatSpy).not.toHaveBeenCalled(); // 30s interval — not waited on

    unmount();
    await waitFor(() => expect(leaveSpy).toHaveBeenCalled());
    expect(leaveSpy.mock.calls[0][0]).toMatchObject({ habitatId: "hab-1" });
    expect(leaveSpy.mock.calls[0][0]).not.toHaveProperty("boardId");
  });
});

// Late import so the vi.spyOn on `api.presence.*` runs against the post-mock module.
import { usePresence as usePresenceHook } from "./usePresence.js";