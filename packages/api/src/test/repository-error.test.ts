import { describe, it, expect } from "vitest";
import {
  RepositoryError,
  repositoryCreateError,
  repositoryUpdateError,
  repositoryDeleteError,
  repositoryUpsertError,
  repositoryReadError,
  repositoryNotFoundError,
  repositoryTransactionError,
  assertFound,
} from "../errors/repository.js";
import { isAppError } from "../errors.js";

describe("RepositoryError", () => {
  it("extends AppError", () => {
    const err = new RepositoryError("agent", "create", "Failed to create agent");
    expect(isAppError(err)).toBe(true);
  });

  it("has statusCode 500 by default", () => {
    const err = new RepositoryError("agent", "create", "Failed to create agent");
    expect(err.statusCode).toBe(500);
  });

  it("has code REPOSITORY_ERROR", () => {
    const err = new RepositoryError("agent", "create", "Failed to create agent");
    expect(err.code).toBe("REPOSITORY_ERROR");
  });

  it("exposes entity, operation, and entityId", () => {
    const cause = new Error("UNIQUE constraint failed");
    const err = new RepositoryError("agent", "update", "msg", cause, "agent-123");
    expect(err.entity).toBe("agent");
    expect(err.operation).toBe("update");
    expect(err.entityId).toBe("agent-123");
    expect(err.cause).toBe(cause);
  });

  it("includes entity context in details", () => {
    const cause = new Error("boom");
    const err = new RepositoryError("task", "delete", "msg", cause, "task-456");
    expect(err.details).toEqual({
      entity: "task",
      operation: "delete",
      entityId: "task-456",
      causeMessage: "boom",
    });
  });

  it("sets name to RepositoryError", () => {
    const err = new RepositoryError("agent", "create", "msg");
    expect(err.name).toBe("RepositoryError");
  });

  it("includes causeCode in details when cause is a SqliteError", () => {
    const sqliteErr = new Error("UNIQUE constraint failed") as Error & {
      code: string;
      name: string;
    };
    sqliteErr.name = "SqliteError";
    sqliteErr.code = "SQLITE_CONSTRAINT_UNIQUE";
    const err = new RepositoryError("agent", "create", "msg", sqliteErr, "agent-1");
    expect((err.details as Record<string, unknown>).causeCode).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  it("leaves causeCode undefined when cause is not a SqliteError", () => {
    const plainErr = new Error("boom");
    const err = new RepositoryError("agent", "create", "msg", plainErr, "agent-1");
    expect((err.details as Record<string, unknown>).causeCode).toBeUndefined();
  });
});

describe("factory functions", () => {
  it("repositoryCreateError produces a create-type error", () => {
    const cause = new Error("FK violation");
    const err = repositoryCreateError("habitat", cause, "hab-1");
    expect(err.entity).toBe("habitat");
    expect(err.operation).toBe("create");
    expect(err.message).toBe("Failed to create habitat");
    expect(err.entityId).toBe("hab-1");
    expect(err.cause).toBe(cause);
  });

  it("repositoryUpdateError produces an update-type error", () => {
    const err = repositoryUpdateError("task", undefined, "task-1");
    expect(err.operation).toBe("update");
    expect(err.message).toBe("Failed to update task");
  });

  it("repositoryDeleteError produces a delete-type error", () => {
    const err = repositoryDeleteError("agent", undefined, "agent-1");
    expect(err.operation).toBe("delete");
    expect(err.message).toBe("Failed to delete agent");
  });

  it("repositoryUpsertError produces an upsert-type error", () => {
    const err = repositoryUpsertError("pulse", undefined, "pulse-1");
    expect(err.operation).toBe("upsert");
    expect(err.message).toBe("Failed to upsert pulse");
  });

  it("repositoryReadError produces a read-type error", () => {
    const err = repositoryReadError("board", undefined, "board-1");
    expect(err.operation).toBe("read");
    expect(err.message).toBe("Failed to read board");
  });

  it("repositoryNotFoundError produces a not-found error with read operation", () => {
    const err = repositoryNotFoundError("comment", "comment-1");
    expect(err.operation).toBe("read");
    expect(err.message).toBe("comment not found: comment-1");
    expect(err.entityId).toBe("comment-1");
    expect(err.cause).toBeUndefined();
  });

  it("repositoryTransactionError produces a transaction-type error", () => {
    const cause = new Error("SQLITE_BUSY");
    const err = repositoryTransactionError("feature", cause, "feat-1");
    expect(err.operation).toBe("transaction");
    expect(err.message).toBe("Transaction failed for feature");
    expect(err.cause).toBe(cause);
  });

  it("all factories work without optional cause/entityId", () => {
    expect(repositoryCreateError("a").entity).toBe("a");
    expect(repositoryUpdateError("b").entityId).toBeUndefined();
    expect(repositoryDeleteError("c").cause).toBeUndefined();
  });
});

describe("assertFound", () => {
  it("returns the value when present", () => {
    const obj = { id: "x" };
    expect(assertFound(obj, "entity", "x")).toBe(obj);
  });

  it("throws repositoryNotFoundError when value is null", () => {
    try {
      assertFound(null, "agent", "agent-1");
      expect.fail("should have thrown");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      expect((err as Error & { code: string }).code).toBe("REPOSITORY_ERROR");
      expect((err as Error & { message: string }).message).toBe("agent not found: agent-1");
    }
  });

  it("throws repositoryNotFoundError when value is undefined", () => {
    try {
      assertFound(undefined, "board", "board-1");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error & { message: string }).message).toBe("board not found: board-1");
    }
  });
});
