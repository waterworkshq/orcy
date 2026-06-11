import { describe, it, expect, vi, beforeEach } from "vitest";

let _usersStore: Record<
  string,
  { id: string; username: string; displayName: string; email: string | null; role: string }
> = {};
let _getResult: Record<string, unknown> | undefined = undefined;
let _allResult: Array<Record<string, unknown>> = [];
let _updateRun = vi.fn();

function createMockDb() {
  const doSelect = () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      get: () => _getResult,
      all: () => _allResult,
    };
    return chain;
  };

  const doUpdate = () => {
    const chain = {
      set: () => chain,
      where: () => chain,
      run: () => {
        _updateRun();
      },
    };
    return chain;
  };

  return { select: () => doSelect(), update: () => doUpdate() };
}

vi.mock("../db/index.js", () => ({
  getDb: () => createMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../repositories/agent.js", () => ({
  getAgentById: vi.fn(),
}));

vi.mock("../db/schema/index.js", () => ({
  users: {
    id: "id",
    username: "username",
    displayName: "display_name",
    email: "email",
    role: "role",
    updatedAt: "updated_at",
  },
  agents: {
    id: "id",
    name: "name",
    type: "type",
  },
  tasks: {
    id: "id",
  },
}));

const drizzleMocks = vi.hoisted(() => {
  const sqlJoinMock = vi.fn((_items: unknown[], _sep: unknown) => ({ _type: "sqlJoin" }));
  const sqlTagFnMock = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({
    _type: "sqlTemplate",
  }));
  (sqlTagFnMock as any).join = sqlJoinMock;
  return { sql: sqlTagFnMock };
});

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_col: unknown, _val: unknown) => ({ _type: "eq" })),
    sql: drizzleMocks.sql,
  };
});

import {
  findUsersByUsernamesCaseInsensitive,
  getUserById,
  updateUserEmail,
  getAdmins,
  getUserEmail as repoGetUserEmail,
  getActorName,
} from "../repositories/user.js";
import { getAgentById } from "../repositories/agent.js";

describe("user repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _usersStore = {};
    _getResult = undefined;
    _allResult = [];
    _updateRun = vi.fn();
  });

  describe("findUsersByUsernamesCaseInsensitive", () => {
    it("returns matching users", () => {
      _allResult = [
        { id: "u1", username: "Vikas" },
        { id: "u2", username: "vikas_admin" },
      ];

      const result = findUsersByUsernamesCaseInsensitive(["Vikas", "vIkAs"]);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("u1");
      expect(result[0].username).toBe("Vikas");
    });

    it("returns empty array for empty input", () => {
      const result = findUsersByUsernamesCaseInsensitive([]);
      expect(result).toEqual([]);
    });

    it("deduplicates case-insensitive usernames", () => {
      _allResult = [{ id: "u1", username: "testuser" }];

      findUsersByUsernamesCaseInsensitive(["TestUser", "testuser"]);

      expect(_allResult).toBeDefined();
    });

    it("returns empty array when no users match", () => {
      _allResult = [];

      const result = findUsersByUsernamesCaseInsensitive(["NonexistentUser"]);

      expect(result).toEqual([]);
    });
  });

  describe("getUserById", () => {
    it("returns user when found", () => {
      _getResult = {
        id: "user-1",
        username: "vikas",
        displayName: "Vikas",
        email: "vikas@test.com",
        role: "admin",
      };

      const result = getUserById("user-1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("user-1");
      expect(result!.username).toBe("vikas");
      expect(result!.displayName).toBe("Vikas");
      expect(result!.email).toBe("vikas@test.com");
      expect(result!.role).toBe("admin");
    });

    it("returns null when user not found", () => {
      _getResult = undefined;

      const result = getUserById("nonexistent");

      expect(result).toBeNull();
    });

    it("returns null when get returns undefined", () => {
      _getResult = undefined;

      const result = getUserById("any-id");

      expect(result).toBeNull();
    });
  });

  describe("updateUserEmail", () => {
    it("updates user email", () => {
      updateUserEmail("user-1", "new@test.com");

      expect(_updateRun).toHaveBeenCalled();
    });

    it("sets email to null when empty string provided", () => {
      updateUserEmail("user-1", "");

      expect(_updateRun).toHaveBeenCalled();
    });
  });

  describe("getAdmins", () => {
    it("returns admin user ids", () => {
      _allResult = [{ id: "u1" }, { id: "u2" }];
      const result = getAdmins();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("u1");
    });

    it("returns empty array when no admins", () => {
      _allResult = [];
      const result = getAdmins();
      expect(result).toEqual([]);
    });
  });

  describe("getUserEmail", () => {
    it("returns email when found", () => {
      _getResult = { email: "user@test.com" };
      const result = repoGetUserEmail("user-1");
      expect(result).toBe("user@test.com");
    });

    it("returns null when not found", () => {
      _getResult = undefined;
      const result = repoGetUserEmail("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getActorName", () => {
    it("returns agent name when agent exists", () => {
      vi.mocked(getAgentById).mockReturnValue({ name: "Bot-1" } as any);
      const result = getActorName("agent-1");
      expect(result).toBe("Bot-1");
    });

    it("returns user displayName when no agent", () => {
      vi.mocked(getAgentById).mockReturnValue(null);
      _getResult = { displayName: "Vikas K.", username: "vikas" };
      const result = getActorName("user-1");
      expect(result).toBe("Vikas K.");
    });

    it("falls back to username when displayName empty", () => {
      vi.mocked(getAgentById).mockReturnValue(null);
      _getResult = { displayName: "", username: "vikas" };
      const result = getActorName("user-1");
      expect(result).toBe("vikas");
    });

    it("returns actorId when no agent or user", () => {
      vi.mocked(getAgentById).mockReturnValue(null);
      _getResult = undefined;
      const result = getActorName("orphan-id");
      expect(result).toBe("orphan-id");
    });
  });
});
