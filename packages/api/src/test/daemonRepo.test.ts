import { describe, it, expect, vi, beforeEach } from "vitest";

const schemaStubs = vi.hoisted(() => ({
  daemonInstances: {
    id: "id",
    name: "name",
    hostname: "hostname",
    tokenHash: "token_hash",
    maxConcurrent: "max_concurrent",
    daemonVersion: "daemon_version",
    lastHeartbeatAt: "last_heartbeat_at",
    status: "status",
    metadata: "metadata",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  daemonAgents: {
    id: "id",
    daemonId: "daemon_id",
    agentId: "agent_id",
    cliType: "cli_type",
    cliVersion: "cli_version",
    cliPath: "cli_path",
    status: "status",
    lastSeenAt: "last_seen_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  daemonSessions: {
    id: "id",
    daemonId: "daemon_id",
    agentId: "agent_id",
    taskId: "task_id",
    habitatId: "habitat_id",
    pid: "pid",
    cliSessionId: "cli_session_id",
    workdir: "workdir",
    status: "status",
    lastProgress: "last_progress",
    startedAt: "started_at",
    endedAt: "ended_at",
    updatedAt: "updated_at",
  },
  agents: {},
  tasks: {},
  habitats: {},
}));

let _insertValues: Record<string, unknown> = {};
let _insertRun = vi.fn();
let _updateSetValues: Record<string, unknown> = {};
let _updateRun = vi.fn();
let _deleteRun = vi.fn();
let _selectResult: Array<Record<string, unknown>> = [];
let _selectQueue: Array<Array<Record<string, unknown>>> = [];

type Chain = Record<string, unknown>;

function createMockDb() {
  const doInsert = () => {
    const chain: Chain = {
      values: (vals: Record<string, unknown>) => {
        _insertValues = { ...vals };
        _insertRun(vals);
        return chain;
      },
      run: () => {},
    };
    return chain;
  };
  const doSelect = () => {
    const chain: Chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      all: () => (_selectQueue.length ? _selectQueue.shift()! : _selectResult),
    };
    return chain;
  };
  const doUpdate = () => {
    const chain: Chain = {
      set: (vals: Record<string, unknown>) => {
        _updateSetValues = { ...vals };
        return chain;
      },
      where: () => chain,
      run: () => {
        _updateRun();
      },
    };
    return chain;
  };
  const doDelete = () => {
    const chain: Chain = {
      where: () => chain,
      run: () => {
        _deleteRun();
      },
    };
    return chain;
  };
  return {
    insert: () => doInsert(),
    select: () => doSelect(),
    update: () => doUpdate(),
    delete: () => doDelete(),
  };
}

vi.mock("../db/index.js", () => ({ getDb: () => createMockDb() }));
vi.mock("../db/schema/index.js", () => schemaStubs);

const sqlMocks = vi.hoisted(() => {
  const fn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({
    _type: "sqlTemplate",
  }));
  return {
    sql: fn,
    eq: vi.fn((_a: unknown, _b: unknown) => ({ _type: "eq" })),
    and: vi.fn((..._args: unknown[]) => ({ _type: "and" })),
  };
});

vi.mock("drizzle-orm", () => ({
  sql: sqlMocks.sql,
  eq: sqlMocks.eq,
  and: sqlMocks.and,
}));

vi.mock("uuid", () => ({ v4: () => "test-uuid" }));
vi.mock("../lib/daemonToken.js", () => ({
  hashDaemonToken: (t: string) => `hash-of-${t}`,
}));

import {
  createDaemon,
  getDaemonById,
  getDaemonByTokenHash,
  updateDaemonHeartbeat,
  setDaemonStatus,
  listDaemons,
  createDaemonAgent,
  getDaemonAgentByAgentId,
  isAgentOwnedByDaemon,
  updateDaemonAgentStatus,
  createDaemonSession,
  getSessionById,
  getActiveSessionByTaskId,
  updateSessionStatus,
  deleteDaemon,
} from "../repositories/daemon.js";

describe("daemonRepository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _insertValues = {};
    _updateSetValues = {};
    _selectResult = [];
    _selectQueue = [];
  });

  describe("daemon instances", () => {
    it("createDaemon inserts and returns daemon", () => {
      _selectResult = [
        {
          id: "test-uuid",
          name: "ws",
          hostname: "host",
          status: "online",
          maxConcurrent: 4,
          daemonVersion: "0.14.0",
          lastHeartbeatAt: "now",
          metadata: {},
          createdAt: "now",
          updatedAt: "now",
        },
      ];
      const result = createDaemon({
        name: "ws",
        hostname: "host",
        maxConcurrent: 4,
        daemonVersion: "0.14.0",
        plainToken: "daemon-test",
      });
      expect(_insertRun).toHaveBeenCalled();
      expect(result.id).toBe("test-uuid");
      expect(result.name).toBe("ws");
    });

    it("getDaemonById returns null when not found", () => {
      _selectResult = [];
      expect(getDaemonById("nonexistent")).toBeNull();
    });

    it("getDaemonByTokenHash returns daemon by hash", () => {
      _selectResult = [{ id: "d1", name: "ws" } as any];
      const result = getDaemonByTokenHash("hash-of-token");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("d1");
    });

    it("updateDaemonHeartbeat sets online status and timestamp", () => {
      _selectResult = [{ id: "d1", status: "online" } as any];
      updateDaemonHeartbeat("d1");
      expect(_updateRun).toHaveBeenCalled();
      expect(_updateSetValues).toHaveProperty("status", "online");
      expect(_updateSetValues).toHaveProperty("lastHeartbeatAt");
    });

    it("setDaemonStatus updates status", () => {
      _selectResult = [{ id: "d1", status: "draining" } as any];
      setDaemonStatus("d1", "draining");
      expect(_updateSetValues).toHaveProperty("status", "draining");
    });

    it("listDaemons returns all", () => {
      _selectResult = [{ id: "d1" }, { id: "d2" }] as any;
      expect(listDaemons()).toHaveLength(2);
    });

    it("deleteDaemon deletes", () => {
      deleteDaemon("d1");
      expect(_deleteRun).toHaveBeenCalled();
    });
  });

  describe("daemon agents", () => {
    it("createDaemonAgent inserts and returns row", () => {
      _selectResult = [
        {
          id: "test-uuid",
          daemonId: "d1",
          agentId: "a1",
          cliType: "cursor",
          cliPath: "/usr/bin/cursor-agent",
          status: "idle",
        } as any,
      ];
      const result = createDaemonAgent({
        daemonId: "d1",
        agentId: "a1",
        cliType: "cursor",
        cliVersion: "1.0",
        cliPath: "/usr/bin/cursor-agent",
      });
      expect(_insertRun).toHaveBeenCalled();
      expect(result.agentId).toBe("a1");
    });

    it("getDaemonAgentByAgentId returns agent", () => {
      _selectResult = [{ id: "da1", agentId: "a1" } as any];
      expect(getDaemonAgentByAgentId("a1")!.id).toBe("da1");
    });

    it("getDaemonAgentByAgentId returns null when not found", () => {
      _selectResult = [];
      expect(getDaemonAgentByAgentId("x")).toBeNull();
    });

    it("isAgentOwnedByDaemon returns true when owned", () => {
      _selectResult = [{ id: "da1" }] as any;
      expect(isAgentOwnedByDaemon("a1", "d1")).toBe(true);
    });

    it("isAgentOwnedByDaemon returns false when not owned", () => {
      _selectResult = [];
      expect(isAgentOwnedByDaemon("a1", "d1")).toBe(false);
    });

    it("updateDaemonAgentStatus sets status and lastSeenAt", () => {
      _selectResult = [{ id: "da1", status: "working" } as any];
      updateDaemonAgentStatus("da1", "working");
      expect(_updateSetValues).toHaveProperty("status", "working");
      expect(_updateSetValues).toHaveProperty("lastSeenAt");
    });
  });

  describe("daemon sessions", () => {
    it("createDaemonSession inserts with starting status", () => {
      _selectResult = [
        {
          id: "test-uuid",
          daemonId: "d1",
          agentId: "a1",
          taskId: "t1",
          habitatId: "h1",
          workdir: "/tmp/w",
          status: "starting",
        } as any,
      ];
      const result = createDaemonSession({
        daemonId: "d1",
        agentId: "a1",
        taskId: "t1",
        habitatId: "h1",
        workdir: "/tmp/w",
      });
      expect(_insertRun).toHaveBeenCalled();
      expect(result.status).toBe("starting");
    });

    it("getSessionById returns null when not found", () => {
      _selectResult = [];
      expect(getSessionById("x")).toBeNull();
    });

    it("updateSessionStatus transitions to running", () => {
      _selectResult = [{ id: "s1", status: "running" } as any];
      updateSessionStatus("s1", "running");
      expect(_updateSetValues).toHaveProperty("status", "running");
      expect(_updateSetValues).not.toHaveProperty("endedAt");
    });

    it("updateSessionStatus sets endedAt for terminal status", () => {
      _selectResult = [{ id: "s1", status: "completed" } as any];
      updateSessionStatus("s1", "completed");
      expect(_updateSetValues).toHaveProperty("status", "completed");
      expect(_updateSetValues).toHaveProperty("endedAt");
    });

    it("updateSessionStatus stores lastProgress", () => {
      _selectResult = [{ id: "s1", status: "running" } as any];
      updateSessionStatus("s1", "running", "50% done");
      expect(_updateSetValues).toHaveProperty("lastProgress", "50% done");
    });

    it("getActiveSessionByTaskId returns matching session", () => {
      _selectResult = [{ id: "s1", taskId: "t1", status: "running" } as any];
      expect(getActiveSessionByTaskId("t1")!.id).toBe("s1");
    });

    it("getActiveSessionByTaskId returns null when no active session", () => {
      _selectResult = [];
      expect(getActiveSessionByTaskId("t1")).toBeNull();
    });
  });
});
