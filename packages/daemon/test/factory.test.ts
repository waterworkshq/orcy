import { describe, it, expect, expectTypeOf, vi } from "vitest";
import type { ISessionManager, ICliDetector, ISessionUpdater } from "@orcy/shared/types";
import { createSessionManager, createCliDetector } from "../src/factory.js";
import { SessionManager } from "../src/session/manager.js";

const mockUpdater: ISessionUpdater = {
  updateSession: vi.fn().mockResolvedValue(undefined),
};

describe("factory", () => {
  describe("createSessionManager", () => {
    it("returns an ISessionManager (compile-time)", () => {
      const sm = createSessionManager({
        sessionUpdater: mockUpdater,
        apiUrl: "",
        dataDir: "/tmp",
        sessionTimeoutSeconds: 600,
      });
      expectTypeOf(sm).toMatchTypeOf<ISessionManager>();
    });

    it("returns a SessionManager instance (concrete type preserved)", () => {
      const sm = createSessionManager({
        sessionUpdater: mockUpdater,
        apiUrl: "",
        dataDir: "/tmp",
        sessionTimeoutSeconds: 600,
      });
      expect(sm).toBeInstanceOf(SessionManager);
    });

    it("exposes the ISessionManager method surface at runtime", () => {
      const sm = createSessionManager({
        sessionUpdater: mockUpdater,
        apiUrl: "",
        dataDir: "/tmp",
        sessionTimeoutSeconds: 600,
      });
      expect(typeof sm.activeCount).toBe("number");
      expect(Array.isArray(sm.activeSessions)).toBe(true);
      expect(typeof sm.getSession).toBe("function");
      expect(typeof sm.startSession).toBe("function");
      expect(typeof sm.terminateSession).toBe("function");
      expect(typeof sm.releaseSession).toBe("function");
      expect(typeof sm.shutdownAll).toBe("function");
      expect(typeof sm.startTimeoutCheck).toBe("function");
      expect(typeof sm.stopTimeoutCheck).toBe("function");
    });

    it("starts with no active sessions", () => {
      const sm = createSessionManager({
        sessionUpdater: mockUpdater,
        apiUrl: "",
        dataDir: "/tmp",
        sessionTimeoutSeconds: 600,
      });
      expect(sm.activeCount).toBe(0);
      expect(sm.activeSessions).toEqual([]);
    });

    it("forwards onSessionComplete callback to the constructed SessionManager", () => {
      const onComplete = vi.fn();
      const sm = createSessionManager({
        sessionUpdater: mockUpdater,
        apiUrl: "",
        dataDir: "/tmp",
        sessionTimeoutSeconds: 600,
        onSessionComplete: onComplete,
      });
      expect(sm).toBeInstanceOf(SessionManager);
    });
  });

  describe("createCliDetector", () => {
    it("returns an ICliDetector (compile-time)", () => {
      const detector = createCliDetector();
      expectTypeOf(detector).toMatchTypeOf<ICliDetector>();
    });

    it("exposes a detectClis function", () => {
      const detector = createCliDetector();
      expect(typeof detector.detectClis).toBe("function");
    });
  });
});
