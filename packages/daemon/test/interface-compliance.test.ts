import { describe, it, expect, expectTypeOf, vi } from "vitest";
import type {
  ISessionManager,
  ISessionUpdater,
  ICliDetector,
  IClaimStrategy,
  IHeartbeatStrategy,
  IPollLoop,
} from "@orcy/shared/types";
import { SessionManager } from "../src/session/manager.js";
import { PollLoop } from "../src/poll-loop.js";
import { HttpClaimStrategy } from "../src/httpClaimStrategy.js";
import { HttpHeartbeatStrategy } from "../src/httpHeartbeatStrategy.js";
import { detectClis } from "../src/detector.js";
import { WorkdirError } from "@orcy/shared";

const mockUpdater: ISessionUpdater = {
  updateSession: vi.fn().mockResolvedValue(undefined),
};

describe("interface compliance", () => {
  describe("SessionManager implements ISessionManager", () => {
    it("satisfies ISessionManager at compile time", () => {
      expectTypeOf<SessionManager>().toMatchTypeOf<ISessionManager>();
    });

    it("exposes activeCount as a number", () => {
      const sm = new SessionManager({
        sessionUpdater: mockUpdater,
        apiUrl: "",
        dataDir: "/tmp",
        sessionTimeoutSeconds: 60,
      });
      expect(typeof sm.activeCount).toBe("number");
    });

    it("exposes activeSessions as an array", () => {
      const sm = new SessionManager({
        sessionUpdater: mockUpdater,
        apiUrl: "",
        dataDir: "/tmp",
        sessionTimeoutSeconds: 60,
      });
      expect(Array.isArray(sm.activeSessions)).toBe(true);
    });

    it("exposes all ISessionManager methods", () => {
      const sm = new SessionManager({
        sessionUpdater: mockUpdater,
        apiUrl: "",
        dataDir: "/tmp",
        sessionTimeoutSeconds: 60,
      });
      expect(typeof sm.getSession).toBe("function");
      expect(typeof sm.startSession).toBe("function");
      expect(typeof sm.terminateSession).toBe("function");
      expect(typeof sm.releaseSession).toBe("function");
      expect(typeof sm.shutdownAll).toBe("function");
      expect(typeof sm.startTimeoutCheck).toBe("function");
      expect(typeof sm.stopTimeoutCheck).toBe("function");
    });
  });

  describe("PollLoop implements IPollLoop", () => {
    it("satisfies IPollLoop at compile time", () => {
      expectTypeOf<PollLoop>().toMatchTypeOf<IPollLoop>();
    });

    it("exposes start, stop, and isRunning", () => {
      const pl = new PollLoop({
        config: {
          apiUrl: "",
          registrationToken: null,
          name: "test",
          maxConcurrent: 1,
          pollIntervalSeconds: 600,
          heartbeatIntervalSeconds: 600,
          sessionTimeoutSeconds: 600,
          dataDir: "/tmp",
          habitatIds: [],
        },
        apiClient: {} as never,
        sessionManager: {} as never,
        agents: [],
      });
      expect(typeof pl.start).toBe("function");
      expect(typeof pl.stop).toBe("function");
      expect(typeof pl.isRunning).toBe("boolean");
    });
  });

  describe("HttpClaimStrategy implements IClaimStrategy", () => {
    it("satisfies IClaimStrategy at compile time", () => {
      expectTypeOf<HttpClaimStrategy>().toMatchTypeOf<IClaimStrategy>();
    });

    it("exposes claimNext method", () => {
      const strategy = new HttpClaimStrategy({ claimNext: vi.fn() } as never);
      expect(typeof strategy.claimNext).toBe("function");
    });
  });

  describe("HttpHeartbeatStrategy implements IHeartbeatStrategy", () => {
    it("satisfies IHeartbeatStrategy at compile time", () => {
      expectTypeOf<HttpHeartbeatStrategy>().toMatchTypeOf<IHeartbeatStrategy>();
    });

    it("exposes sendHeartbeat method", () => {
      const strategy = new HttpHeartbeatStrategy({ heartbeat: vi.fn() } as never);
      expect(typeof strategy.sendHeartbeat).toBe("function");
    });
  });

  describe("detectClis satisfies ICliDetector shape", () => {
    it("returns DetectedCli[] at compile time", () => {
      expectTypeOf(detectClis).returns.toMatchTypeOf<ReturnType<ICliDetector["detectClis"]>>();
    });
  });

  describe("WorkdirError", () => {
    it("is an Error subclass", () => {
      const err = new WorkdirError("test");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(WorkdirError);
      expect(err.name).toBe("WorkdirError");
      expect(err.message).toBe("test");
    });
  });
});
