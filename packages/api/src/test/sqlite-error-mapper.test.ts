import { describe, it, expect } from "vitest";
import { isSqliteError, mapSqliteErrorToHttp } from "../errors/sqlite.js";

function makeSqliteError(code: string, message?: string): Error {
  const err = new Error(message ?? `SQLite error: ${code}`);
  err.name = "SqliteError";
  (err as Error & { code: string }).code = code;
  return err;
}

describe("isSqliteError", () => {
  it('returns true for an Error with name "SqliteError" and string code', () => {
    const err = makeSqliteError("SQLITE_CONSTRAINT_UNIQUE");
    expect(isSqliteError(err)).toBe(true);
  });

  it("returns false for an Error with wrong name", () => {
    const err = new Error("boom");
    (err as Error & { code: string }).code = "SQLITE_CONSTRAINT_UNIQUE";
    expect(isSqliteError(err)).toBe(false);
  });

  it("returns false for an Error with missing code", () => {
    const err = new Error("boom");
    err.name = "SqliteError";
    expect(isSqliteError(err)).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isSqliteError(null)).toBe(false);
    expect(isSqliteError(undefined)).toBe(false);
    expect(isSqliteError("string error")).toBe(false);
    expect(isSqliteError({ name: "SqliteError", code: "X" })).toBe(false);
    expect(isSqliteError(42)).toBe(false);
  });
});

describe("mapSqliteErrorToHttp", () => {
  it("maps UNIQUE constraint to 409 Conflict", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_CONSTRAINT_UNIQUE") as any);
    expect(result).toEqual({
      statusCode: 409,
      code: "CONFLICT",
      message: "Resource already exists",
    });
  });

  it("maps PRIMARY KEY constraint to 409 Conflict", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_CONSTRAINT_PRIMARYKEY") as any);
    expect(result.statusCode).toBe(409);
    expect(result.code).toBe("CONFLICT");
  });

  it("maps FOREIGN KEY constraint to 400 Validation", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_CONSTRAINT_FOREIGNKEY") as any);
    expect(result).toEqual({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Referenced resource does not exist",
    });
  });

  it("maps NOT NULL constraint to 400 Validation", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_CONSTRAINT_NOTNULL") as any);
    expect(result.statusCode).toBe(400);
    expect(result.code).toBe("VALIDATION_ERROR");
  });

  it("maps CHECK constraint to 400 Validation", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_CONSTRAINT_CHECK") as any);
    expect(result.statusCode).toBe(400);
    expect(result.code).toBe("VALIDATION_ERROR");
  });

  it("maps database busy to 503 Service Unavailable", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_BUSY") as any);
    expect(result).toEqual({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Database is busy, please retry",
    });
  });

  it("maps SQLITE_BUSY_RECOVERY to 503", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_BUSY_RECOVERY") as any);
    expect(result.statusCode).toBe(503);
  });

  it("maps SQLITE_LOCKED to 503", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_LOCKED") as any);
    expect(result.statusCode).toBe(503);
  });

  it("maps read-only database to 503", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_READONLY") as any);
    expect(result).toEqual({
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Database is read-only",
    });
  });

  it("maps corrupt database to 500 Internal Error", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_CORRUPT") as any);
    expect(result.statusCode).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
  });

  it("maps schema change to 500", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_SCHEMA") as any);
    expect(result.statusCode).toBe(500);
  });

  it("falls through to 500 for unknown codes", () => {
    const result = mapSqliteErrorToHttp(makeSqliteError("SQLITE_UNKNOWN_FUTURE_CODE") as any);
    expect(result.statusCode).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).toBe("Database error");
  });
});
