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
  it("join sends only sessionId and habitatId — identity is server-derived", async () => {
    await presenceApi.join({ sessionId: "s1", habitatId: "hab-1" });

    expect(requestMock).toHaveBeenCalledWith(
      "/sse/presence/join",
      expect.objectContaining({ method: "POST" }),
    );
    const body = lastBody();
    const parsed = JSON.parse(body);
    expect(parsed).toMatchObject({ sessionId: "s1", habitatId: "hab-1" });
    expect(parsed).not.toHaveProperty("boardId");
    expect(parsed).not.toHaveProperty("type");
    expect(parsed).not.toHaveProperty("userId");
    expect(parsed).not.toHaveProperty("userName");
    expect(parsed).not.toHaveProperty("agentId");
    expect(parsed).not.toHaveProperty("agentName");
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
  it("joins with only sessionId and habitatId, leaves on cleanup", async () => {
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
    expect(joinSpy.mock.calls[0][0]).not.toHaveProperty("type");
    expect(joinSpy.mock.calls[0][0]).not.toHaveProperty("userId");
    expect(joinSpy.mock.calls[0][0]).not.toHaveProperty("userName");

    expect(heartbeatSpy).not.toHaveBeenCalled(); // 30s interval — not waited on

    unmount();
    await waitFor(() => expect(leaveSpy).toHaveBeenCalled());
    expect(leaveSpy.mock.calls[0][0]).toMatchObject({ habitatId: "hab-1" });
    expect(leaveSpy.mock.calls[0][0]).not.toHaveProperty("boardId");
  });

  it("does not send a leave or beacon on beforeunload — abrupt closes expire server-side", async () => {
    const { api } = await import("../api/index.js");
    const leaveSpy = vi
      .spyOn(api.presence, "leave")
      .mockResolvedValue({ success: true } as never);
    // jsdom does not implement sendBeacon — install a writable mock so a
    // restored unload beacon is genuinely observable.
    const nav = navigator as Navigator & {
      sendBeacon?: (url: string | URL, data?: BodyInit | null) => boolean;
    };
    const originalBeacon = nav.sendBeacon;
    const beaconMock = vi.fn(() => true);
    nav.sendBeacon = beaconMock;

    try {
      const { unmount } = renderHook(() => usePresenceHook("hab-1"), {
        wrapper: createWrapper(),
      });

      window.dispatchEvent(new Event("beforeunload"));

      expect(beaconMock).not.toHaveBeenCalled();
      expect(leaveSpy).not.toHaveBeenCalled();

      unmount();
      await waitFor(() => expect(leaveSpy).toHaveBeenCalledTimes(1));
      expect(beaconMock).not.toHaveBeenCalled();
    } finally {
      if (originalBeacon === undefined) {
        Reflect.deleteProperty(nav, "sendBeacon");
      } else {
        nav.sendBeacon = originalBeacon;
      }
    }
  });
});

// Late import so the vi.spyOn on `api.presence.*` runs against the post-mock module.
import { usePresence as usePresenceHook } from "./usePresence.js";
