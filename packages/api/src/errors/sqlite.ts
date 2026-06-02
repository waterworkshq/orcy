/**
 * SqliteError detection and HTTP status mapping for better-sqlite3 errors.
 *
 * better-sqlite3 throws errors with `name === "SqliteError"` and a string `code`
 * like "SQLITE_CONSTRAINT_UNIQUE". These are passed through Drizzle unchanged
 * and bubble up to the global error handler as raw Error objects.
 */

export interface SqliteErrorLike extends Error {
  name: "SqliteError";
  code: string;
}

export interface MappedSqliteError {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * Type guard that checks whether an unknown error looks like a better-sqlite3
 * SqliteError. Checks the `name` property and presence of a string `code`.
 */
export function isSqliteError(err: unknown): err is SqliteErrorLike {
  return (
    err instanceof Error &&
    err.name === "SqliteError" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/**
 * Maps a SqliteError to a structured HTTP response shape.
 *
 * - UNIQUE/PRIMARY KEY violations → 409 Conflict
 * - FOREIGN KEY/NOT NULL/CHECK violations → 400 Validation error
 * - Database busy/locked → 503 Service unavailable
 * - Read-only/corrupt → 500/503
 * - Everything else → 500 Internal error
 */
export function mapSqliteErrorToHttp(err: SqliteErrorLike): MappedSqliteError {
  const code = err.code;

  switch (code) {
    case "SQLITE_CONSTRAINT_UNIQUE":
    case "SQLITE_CONSTRAINT_PRIMARYKEY":
      return { statusCode: 409, code: "CONFLICT", message: "Resource already exists" };

    case "SQLITE_CONSTRAINT_FOREIGNKEY":
      return {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "Referenced resource does not exist",
      };

    case "SQLITE_CONSTRAINT_NOTNULL":
    case "SQLITE_CONSTRAINT_CHECK":
      return {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: "Invalid data for database constraint",
      };

    case "SQLITE_BUSY":
    case "SQLITE_BUSY_RECOVERY":
    case "SQLITE_LOCKED":
      return {
        statusCode: 503,
        code: "SERVICE_UNAVAILABLE",
        message: "Database is busy, please retry",
      };

    case "SQLITE_READONLY":
      return { statusCode: 503, code: "SERVICE_UNAVAILABLE", message: "Database is read-only" };

    case "SQLITE_CORRUPT":
    case "SQLITE_SCHEMA":
      return { statusCode: 500, code: "INTERNAL_ERROR", message: "Database integrity error" };

    default:
      return { statusCode: 500, code: "INTERNAL_ERROR", message: "Database error" };
  }
}
