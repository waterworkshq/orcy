import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const mockDetectClis = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const mockDaemonRegister = vi.hoisted(() => vi.fn());
const mockStoreSave = vi.hoisted(() => vi.fn());
const mockStoreLoad = vi.hoisted(() => vi.fn<() => any>(() => null));
const mockPollLoopStart = vi.hoisted(() => vi.fn());
const mockPollLoopStop = vi.hoisted(() => vi.fn());
const mockSessionManagerStartTimeout = vi.hoisted(() => vi.fn());
const mockSessionManagerStopTimeout = vi.hoisted(() => vi.fn());
const mockSessionManagerShutdown = vi.hoisted(() => vi.fn());
const mockRecoverSessions = vi.hoisted(() => vi.fn(() => []));
const mockSetDaemonToken = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockPollLoopConfigs = vi.hoisted(() => [] as any[]);

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@orcy/daemon", () => ({
  detectClis: mockDetectClis,
  loadConfig: mockLoadConfig,
  SUPPORTED_CLIS: [
    { type: "claude-code", bin: "claude", versionArgs: ["--version"] },
    { type: "codex", bin: "codex", versionArgs: ["--version"] },
  ],
  DaemonApiClient: vi.fn(function (this: any) {
    this.register = mockDaemonRegister;
    this.setDaemonToken = mockSetDaemonToken;
  }),
  Store: vi.fn(function (this: any) {
    this.saveCredentials = mockStoreSave;
    this.loadCredentials = mockStoreLoad;
    this.init = vi.fn();
  }),
  PollLoop: vi.fn(function (this: any, options: any) {
    mockPollLoopConfigs.push(options);
    this.start = mockPollLoopStart;
    this.stop = mockPollLoopStop;
  }),
  SessionManager: vi.fn(function (this: any) {
    this.startTimeoutCheck = mockSessionManagerStartTimeout;
    this.stopTimeoutCheck = mockSessionManagerStopTimeout;
    this.shutdownAll = mockSessionManagerShutdown;
    this.activeCount = 0;
    this.activeSessions = [];
  }),
  recoverSessions: mockRecoverSessions,
}));

vi.mock("@orcy/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@orcy/shared")>();
  return actual;
});

import { Command } from "commander";
import { registerDaemonCommands } from "../src/commands/daemon.js";
import { ORCY_PATHS } from "@orcy/shared";

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerDaemonCommands(program);
  return program;
}

const savedExit = process.exit;

beforeEach(() => {
  vi.clearAllMocks();
  mockPollLoopConfigs.length = 0;
  mockSpawn.mockReturnValue({ pid: 12345, unref: vi.fn() });
  process.exit = vi.fn() as any;
  try {
    fs.unlinkSync(path.join(ORCY_PATHS.run, "daemon.pid"));
  } catch {}
});

afterEach(() => {
  process.exit = savedExit;
});

describe("daemon detect", () => {
  it("lists detected CLIs", () => {
    mockDetectClis.mockReturnValue([
      { type: "claude-code", version: "1.0.0", path: "/usr/bin/claude" },
      { type: "codex", version: "0.5.0", path: "/usr/bin/codex" },
    ]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    createProgram().parse(["node", "orcy", "daemon", "detect"]);

    console.log = origLog;
    const output = logs.join("\n");
    expect(output).toContain("Detected 2 CLI(s)");
    expect(output).toContain("claude-code");
    expect(output).toContain("codex");
    expect(output).toContain("v1.0.0");
  });

  it("shows not found message when nothing detected", () => {
    mockDetectClis.mockReturnValue([]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    createProgram().parse(["node", "orcy", "daemon", "detect"]);

    console.log = origLog;
    const output = logs.join("\n");
    expect(output).toContain("No supported CLIs detected");
    expect(output).toContain("Supported tools");
  });
});

describe("daemon register", () => {
  it("registers daemon and saves credentials", async () => {
    mockDetectClis.mockReturnValue([
      { type: "claude-code", version: "1.0.0", path: "/usr/bin/claude" },
    ]);
    mockLoadConfig.mockReturnValue({
      apiUrl: "http://localhost:3000",
      name: "test-daemon",
      registrationToken: "tok-123",
      habitatIds: ["hab-1"],
      maxConcurrent: 4,
      pollIntervalSeconds: 30,
      heartbeatIntervalSeconds: 30,
      sessionTimeoutSeconds: 600,
      dataDir: "/tmp/orcy-daemon-test",
    });
    mockDaemonRegister.mockResolvedValue({
      daemonId: "daemon-abc",
      daemonToken: "dt-xyz",
      heartbeatIntervalSeconds: 30,
      agents: [
        { id: "agent-1", name: "daemon-test-claude-code", type: "claude-code", apiKey: "key-1" },
      ],
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    createProgram().parse([
      "node",
      "orcy",
      "daemon",
      "register",
      "--habitat-ids",
      "hab-1",
      "--name",
      "test-daemon",
    ]);

    await new Promise((r) => setTimeout(r, 50));

    console.log = origLog;
    expect(mockDaemonRegister).toHaveBeenCalled();
    expect(mockStoreSave).toHaveBeenCalled();
    const saved = mockStoreSave.mock.calls[0][0];
    expect(saved.daemonId).toBe("daemon-abc");
    expect(saved.habitatIds).toEqual(["hab-1"]);
    expect(saved.agents).toHaveLength(1);
    const output = logs.join("\n");
    expect(output).toContain("daemon-abc");
    expect(output).toContain("key-1");
  });

  it("rejects empty habitat IDs", async () => {
    const origErr = console.error;
    console.error = vi.fn();

    createProgram().parse(["node", "orcy", "daemon", "register", "--habitat-ids", ""]);

    await new Promise((r) => setTimeout(r, 50));
    console.error = origErr;
    expect(mockDaemonRegister).not.toHaveBeenCalled();
  });
});

describe("daemon start", () => {
  it("errors when no credentials stored", async () => {
    mockStoreLoad.mockReturnValue(null);

    const origErr = console.error;
    console.error = vi.fn();

    createProgram().parse(["node", "orcy", "daemon", "start"]);

    await new Promise((r) => setTimeout(r, 50));

    console.error = origErr;
    expect(mockPollLoopStart).not.toHaveBeenCalled();
  });

  it("starts poll loop when credentials exist", async () => {
    mockStoreLoad.mockReturnValue({
      daemonId: "daemon-abc",
      daemonToken: "dt-xyz",
      apiUrl: "http://localhost:3000",
      habitatIds: ["hab-1"],
      agents: [{ id: "agent-1", name: "test-agent", type: "claude-code", apiKey: "key-1" }],
      registeredAt: "2026-01-01T00:00:00Z",
    });
    mockRecoverSessions.mockResolvedValue([]);

    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: any[]) => logs.push(args.join(" "));
    console.error = (...args: any[]) => logs.push("ERR: " + args.join(" "));

    try {
      createProgram().parse(["node", "orcy", "daemon", "start"]);
    } catch (e: any) {
      logs.push("THREW: " + e.message);
    }

    await new Promise((r) => setTimeout(r, 200));

    console.log = origLog;
    console.error = origErr;

    const output = logs.join("\n");
    expect(mockSetDaemonToken).toHaveBeenCalledWith("dt-xyz");
    expect(mockSessionManagerStartTimeout).toHaveBeenCalled();
    expect(mockPollLoopStart).toHaveBeenCalled();
    expect(mockPollLoopConfigs[0].config.habitatIds).toEqual(["hab-1"]);
    expect(output).toContain("daemon-abc");
    expect(output).toContain("Daemon running");
  });

  it("starts detached daemon using the ESM CLI entrypoint", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    createProgram().parse(["node", "orcy", "daemon", "start", "--detach"]);

    await new Promise((r) => setTimeout(r, 50));
    console.log = origLog;

    expect(mockSpawn).toHaveBeenCalled();
    const [, args] = mockSpawn.mock.calls[0];
    expect(args[0]).toMatch(/index\.js$/);
    expect(args.slice(1, 3)).toEqual(["daemon", "start"]);
    expect(logs.join("\n")).toContain("Daemon started");
  });
});

describe("daemon stop", () => {
  it("reports daemon not running when no PID", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    createProgram().parse(["node", "orcy", "daemon", "stop"]);

    console.log = origLog;
    expect(logs.join("\n")).toContain("not running");
  });
});

describe("daemon status", () => {
  it("shows not registered when no credentials", () => {
    mockStoreLoad.mockReturnValue(null);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    createProgram().parse(["node", "orcy", "daemon", "status"]);

    console.log = origLog;
    const output = logs.join("\n");
    expect(output).toContain("Not registered");
    expect(output).toContain("daemon register");
  });

  it("shows daemon info when registered", () => {
    mockStoreLoad.mockReturnValue({
      daemonId: "daemon-abc",
      daemonToken: "dt-xyz",
      apiUrl: "http://localhost:3000",
      habitatIds: ["hab-1"],
      agents: [{ id: "agent-1", name: "test-agent", type: "claude-code", apiKey: "key-1" }],
      registeredAt: "2026-01-01T00:00:00Z",
    });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    createProgram().parse(["node", "orcy", "daemon", "status"]);

    console.log = origLog;
    const output = logs.join("\n");
    expect(output).toContain("daemon-abc");
    expect(output).toContain("test-agent");
    expect(output).toContain("claude-code");
    expect(output).toContain("2026-01-01");
  });
});
