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

const UNIQUE_CONSTRAINT_RE = /UNIQUE constraint failed/i;

/**
 * Cross-backend duplicate-insert detector for composite-key rows.
 * better-sqlite3 (production) throws a `SqliteError` with
 * `code === "SQLITE_CONSTRAINT_UNIQUE"` or `"SQLITE_CONSTRAINT_PRIMARYKEY"`
 * (a composite PRIMARY KEY duplicate reports the PRIMARYKEY code);
 * drizzle-orm may wrap it, putting the real error on `.cause`. sql.js
 * (tests) throws a plain `Error` whose `message` contains
 * "UNIQUE constraint failed". Anything else is NOT a duplicate — callers
 * keep unrelated failures on their 5xx path.
 */
export function isSqliteDuplicateInsert(err: unknown): boolean {
  if (
    isSqliteError(err) &&
    (err.code === "SQLITE_CONSTRAINT_UNIQUE" || err.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
  ) {
    return true;
  }
  if (err instanceof Error && UNIQUE_CONSTRAINT_RE.test(err.message)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    if (
      isSqliteError(cause) &&
      (cause.code === "SQLITE_CONSTRAINT_UNIQUE" ||
        cause.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
    ) {
      return true;
    }
    if (UNIQUE_CONSTRAINT_RE.test(cause.message)) return true;
  }
  return false;
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
