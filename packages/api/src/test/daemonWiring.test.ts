import { describe, it, expect, expectTypeOf, beforeAll, afterEach } from "vitest";
import type { ISessionManager, DetectedCli } from "@orcy/shared/types";
import {
  getSessionManager,
  releaseSessionManager,
  detectClisOnHost,
  shutdownAllWiring,
  initDaemonWiring,
} from "../daemon-wiring.js";

describe("daemon-wiring", () => {
  const TEST_DAEMON_ID = "wiring-test-daemon";

  beforeAll(async () => {
    await initDaemonWiring();
  });

  afterEach(() => {
    shutdownAllWiring();
    releaseSessionManager(TEST_DAEMON_ID);
  });

  describe("getSessionManager", () => {
    it("returns an ISessionManager (compile-time)", () => {
      const sm = getSessionManager(TEST_DAEMON_ID, "/tmp/orcy-test");
      expectTypeOf(sm).toMatchTypeOf<ISessionManager>();
    });

    it("returns an object with the ISessionManager method surface", () => {
      const sm = getSessionManager(TEST_DAEMON_ID, "/tmp/orcy-test");
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

    it("caches by daemonId (returns same instance on repeat call)", () => {
      const sm1 = getSessionManager(TEST_DAEMON_ID, "/tmp/orcy-test");
      const sm2 = getSessionManager(TEST_DAEMON_ID, "/tmp/orcy-test-different");
      expect(sm1).toBe(sm2);
    });

    it("starts with no active sessions", () => {
      const sm = getSessionManager(`fresh-${Date.now()}`, "/tmp/orcy-test");
      expect(sm.activeCount).toBe(0);
      expect(sm.activeSessions).toEqual([]);
    });

    it("returns distinct instances for distinct daemonIds", () => {
      const sm1 = getSessionManager("daemon-A", "/tmp/orcy-test");
      const sm2 = getSessionManager("daemon-B", "/tmp/orcy-test");
      expect(sm1).not.toBe(sm2);
    });
  });

  describe("releaseSessionManager", () => {
    it("drops the cached instance so a new one is constructed on next call", () => {
      const sm1 = getSessionManager("release-test", "/tmp/orcy-test");
      releaseSessionManager("release-test");
      const sm2 = getSessionManager("release-test", "/tmp/orcy-test");
      expect(sm1).not.toBe(sm2);
    });
  });

  describe("detectClisOnHost", () => {
    it("returns DetectedCli[] (compile-time)", () => {
      const detected = detectClisOnHost();
      expectTypeOf(detected).toMatchTypeOf<DetectedCli[]>();
    });

    it("returns an array", () => {
      const detected = detectClisOnHost();
      expect(Array.isArray(detected)).toBe(true);
    });
  });

  describe("shutdownAllWiring", () => {
    it("clears the session manager cache", () => {
      const sm1 = getSessionManager("shutdown-test", "/tmp/orcy-test");
      shutdownAllWiring();
      const sm2 = getSessionManager("shutdown-test", "/tmp/orcy-test");
      expect(sm1).not.toBe(sm2);
    });
  });
});
