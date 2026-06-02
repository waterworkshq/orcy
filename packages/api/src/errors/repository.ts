import { AppError, ErrorCodes } from "../errors.js";
import { isSqliteError } from "./sqlite.js";

/**
 * Error thrown by repository layer when a database operation fails.
 * Carries operation context (entity, operation, entityId) and the original cause.
 *
 * Extends AppError so it integrates with the global error handler.
 * Distinct from raw SqliteError: it wraps the original error and adds semantic context
 * so logs and error responses can identify which entity/operation failed.
 */
export class RepositoryError extends AppError {
  constructor(
    public entity: string,
    public operation: "create" | "update" | "delete" | "upsert" | "read" | "transaction",
    message: string,
    public cause?: Error,
    public entityId?: string,
  ) {
    super(500, ErrorCodes.REPOSITORY_ERROR, message, {
      entity,
      operation,
      entityId,
      causeMessage: cause?.message,
      causeCode: isSqliteError(cause) ? cause.code : undefined,
    });
    this.name = "RepositoryError";
  }
}

export function repositoryCreateError(
  entity: string,
  cause?: Error,
  entityId?: string,
): RepositoryError {
  return new RepositoryError(entity, "create", `Failed to create ${entity}`, cause, entityId);
}

export function repositoryUpdateError(
  entity: string,
  cause?: Error,
  entityId?: string,
): RepositoryError {
  return new RepositoryError(entity, "update", `Failed to update ${entity}`, cause, entityId);
}

export function repositoryDeleteError(
  entity: string,
  cause?: Error,
  entityId?: string,
): RepositoryError {
  return new RepositoryError(entity, "delete", `Failed to delete ${entity}`, cause, entityId);
}

export function repositoryUpsertError(
  entity: string,
  cause?: Error,
  entityId?: string,
): RepositoryError {
  return new RepositoryError(entity, "upsert", `Failed to upsert ${entity}`, cause, entityId);
}

export function repositoryReadError(
  entity: string,
  cause?: Error,
  entityId?: string,
): RepositoryError {
  return new RepositoryError(entity, "read", `Failed to read ${entity}`, cause, entityId);
}

export function repositoryNotFoundError(entity: string, entityId: string): RepositoryError {
  return new RepositoryError(
    entity,
    "read",
    `${entity} not found: ${entityId}`,
    undefined,
    entityId,
  );
}

export function repositoryTransactionError(
  entity: string,
  cause?: Error,
  entityId?: string,
): RepositoryError {
  return new RepositoryError(
    entity,
    "transaction",
    `Transaction failed for ${entity}`,
    cause,
    entityId,
  );
}

/**
 * Asserts that a getById/read lookup returned a value, throwing a
 * `repositoryNotFoundError` if it returned null/undefined. Reduces the
 * 3-line `if (!result) throw ...; return result;` boilerplate to one call.
 */
export function assertFound<T>(value: T | null | undefined, entity: string, entityId: string): T {
  if (value === null || value === undefined) {
    throw repositoryNotFoundError(entity, entityId);
  }
  return value;
}
