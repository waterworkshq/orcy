import { describe, it, expect, vi, beforeEach } from "vitest";

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.ORCY_API_URL;
    delete process.env.ORCY_DAEMON_NAME;
    delete process.env.ORCY_REGISTRATION_TOKEN;
    delete process.env.ORCY_MAX_CONCURRENT;
    delete process.env.ORCY_POLL_INTERVAL;
    delete process.env.ORCY_HEARTBEAT_INTERVAL;
    delete process.env.ORCY_SESSION_TIMEOUT;
    delete process.env.ORCY_DAEMON_DIR;
    delete process.env.ORCY_HABITAT_IDS;
  });

  it("applies defaults when no env or overrides", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig({ habitatIds: ["hab-1"] });
    expect(config.apiUrl).toBe("http://localhost:3000");
    expect(config.maxConcurrent).toBe(4);
    expect(config.pollIntervalSeconds).toBe(30);
    expect(config.heartbeatIntervalSeconds).toBe(30);
    expect(config.sessionTimeoutSeconds).toBe(600);
    expect(config.habitatIds).toEqual(["hab-1"]);
    expect(config.registrationToken).toBeNull();
  });

  it("reads from env vars", async () => {
    process.env.ORCY_API_URL = "http://orcy.example.com";
    process.env.ORCY_DAEMON_NAME = "my-daemon";
    process.env.ORCY_MAX_CONCURRENT = "8";
    process.env.ORCY_HABITAT_IDS = "hab-1,hab-2";
    process.env.ORCY_DAEMON_DIR = "/tmp/orcy-daemon-test";
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.apiUrl).toBe("http://orcy.example.com");
    expect(config.name).toBe("my-daemon");
    expect(config.maxConcurrent).toBe(8);
    expect(config.habitatIds).toEqual(["hab-1", "hab-2"]);
    expect(config.dataDir).toBe("/tmp/orcy-daemon-test");
  });

  it("overrides take precedence over env", async () => {
    process.env.ORCY_API_URL = "http://env-url";
    process.env.ORCY_HABITAT_IDS = "hab-1";
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig({ apiUrl: "http://override-url", habitatIds: ["hab-2"] });
    expect(config.apiUrl).toBe("http://override-url");
    expect(config.habitatIds).toEqual(["hab-2"]);
  });

  it("throws when no habitat IDs provided", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrow("At least one habitat ID");
  });
});
