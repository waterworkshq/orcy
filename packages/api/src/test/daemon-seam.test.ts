import { describe, it, expect, expectTypeOf, beforeAll } from "vitest";
import type { ISessionManager, IClaimStrategy, DetectedCli } from "@orcy/shared/types";
import {
  initDaemonWiring,
  getSessionManager,
  getClaimStrategy,
  detectClisOnHost,
  shutdownAllWiring,
  releaseSessionManager,
} from "../daemon-wiring.js";
import { InProcessClaimStrategy } from "../services/inProcessClaimStrategy.js";

describe("daemon seam", () => {
  beforeAll(async () => {
    await initDaemonWiring();
  });

  describe("getSessionManager returns a real ISessionManager", () => {
    it("satisfies ISessionManager at compile time", () => {
      const sm = getSessionManager("seam-test-sm", "/tmp/orcy-seam-test");
      expectTypeOf(sm).toMatchTypeOf<ISessionManager>();
    });

    it("starts with zero active sessions", () => {
      const sm = getSessionManager("seam-test-sm", "/tmp/orcy-seam-test");
      expect(sm.activeCount).toBe(0);
      expect(sm.activeSessions).toEqual([]);
    });

    it("returns the same instance for the same daemonId (cached)", () => {
      const sm1 = getSessionManager("seam-test-cache", "/tmp/orcy-seam-test");
      const sm2 = getSessionManager("seam-test-cache", "/tmp/orcy-seam-test");
      expect(sm1).toBe(sm2);
    });

    it("returns distinct instances for distinct daemonIds", () => {
      const sm1 = getSessionManager("seam-distinct-A", "/tmp/orcy-seam-test");
      const sm2 = getSessionManager("seam-distinct-B", "/tmp/orcy-seam-test");
      expect(sm1).not.toBe(sm2);
    });
  });

  describe("getClaimStrategy returns a real IClaimStrategy", () => {
    it("satisfies IClaimStrategy at compile time", () => {
      const cs = getClaimStrategy({
        daemonId: "seam-test-cs",
        isAgentOwnedByDaemon: () => false,
        getHabitatById: () => null,
        getSuggestionsForAgent: () => ({ suggestions: [] }),
        claimTask: () => ({ success: false }),
        getTaskById: () => null,
        createDaemonSession: () => ({ id: "x" }),
      });
      expectTypeOf(cs).toMatchTypeOf<IClaimStrategy>();
    });

    it("returns an InProcessClaimStrategy instance", () => {
      const cs = getClaimStrategy({
        daemonId: "seam-test-cs-type",
        isAgentOwnedByDaemon: () => false,
        getHabitatById: () => null,
        getSuggestionsForAgent: () => ({ suggestions: [] }),
        claimTask: () => ({ success: false }),
        getTaskById: () => null,
        createDaemonSession: () => ({ id: "x" }),
      });
      expect(cs).toBeInstanceOf(InProcessClaimStrategy);
    });

    it("returns null for an unowned agent", async () => {
      const cs = getClaimStrategy({
        daemonId: "seam-test-cs-null",
        isAgentOwnedByDaemon: () => false,
        getHabitatById: () => null,
        getSuggestionsForAgent: () => ({ suggestions: [] }),
        claimTask: () => ({ success: false }),
        getTaskById: () => null,
        createDaemonSession: () => ({ id: "x" }),
      });
      expect(await cs.claimNext("unowned-agent", "h1", "seam-test-cs-null")).toBeNull();
    });
  });

  describe("detectClisOnHost works through the seam", () => {
    it("returns DetectedCli[] at compile time", () => {
      const detected = detectClisOnHost();
      expectTypeOf(detected).toMatchTypeOf<DetectedCli[]>();
    });

    it("returns an array at runtime", () => {
      const detected = detectClisOnHost();
      expect(Array.isArray(detected)).toBe(true);
    });
  });

  describe("lifecycle", () => {
    it("releaseSessionManager clears the cache so next call constructs fresh", () => {
      const id = "seam-lifecycle-release";
      const sm1 = getSessionManager(id, "/tmp/orcy-seam-test");
      releaseSessionManager(id);
      const sm2 = getSessionManager(id, "/tmp/orcy-seam-test");
      expect(sm1).not.toBe(sm2);
    });

    it("shutdownAllWiring clears all cached managers", () => {
      const sm1 = getSessionManager("seam-lifecycle-shutdown-A", "/tmp/orcy-seam-test");
      const sm2 = getSessionManager("seam-lifecycle-shutdown-B", "/tmp/orcy-seam-test");
      shutdownAllWiring();
      const sm1After = getSessionManager("seam-lifecycle-shutdown-A", "/tmp/orcy-seam-test");
      const sm2After = getSessionManager("seam-lifecycle-shutdown-B", "/tmp/orcy-seam-test");
      expect(sm1).not.toBe(sm1After);
      expect(sm2).not.toBe(sm2After);
    });
  });
});
