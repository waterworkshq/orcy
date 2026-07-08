import { createHash } from "crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import * as idempotencyRepo from "../repositories/remoteIdempotency.js";
import { AppError } from "../errors.js";

/**
 * Default TTL for idempotency records: 24 hours. This is the window during
 * which a retry with the same Idempotency-Key can be replayed.
 */
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Augment FastifyRequest to carry the resolved idempotency record. The
 * route handler uses `completeRemoteIdempotency` / `failRemoteIdempotency`
 * to persist the result so retries can replay.
 */
declare module "fastify" {
  interface FastifyRequest {
    remoteIdempotency?: {
      key: string;
      recordId: string;
      isReplay: boolean;
      action: string;
    };
    rawBody?: string;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

function hashRequest(method: string, url: string, body: unknown): string {
  const canonical = `${method.toUpperCase()}\n${url}\n${stableStringify(body ?? null)}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Phase D — Idempotency middleware for remote write routes.
 *
 * Requires `remoteParticipantAuth` to have run first (so `request.remoteParticipant`
 * is set). On the first call with a given key, registers the key. On retry:
 *
 * - If the request fingerprint matches and the prior call completed, replays
 *   the stored response (with `X-Orcy-Idempotent-Replay: true` header)
 * - If the fingerprint differs, returns 409 (mismatched replay)
 * - If the prior request is still pending (in-flight), returns 409
 * - If the prior request failed, returns 409 with the prior error message
 *
 * The Idempotency-Key header is required. After a fresh insert, the route
 * handler MUST call `completeRemoteIdempotency` or `failRemoteIdempotency`
 * (in a try/finally) so retries can replay or report failure.
 */
export function idempotentRemoteWrite(action: string) {
  return async function idempotencyMiddleware(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const ctx = request.remoteParticipant;
    if (!ctx) {
      throw new AppError(
        500,
        "IDEMPOTENCY_REQUIRES_REMOTE_AUTH",
        "idempotentRemoteWrite requires remoteParticipantAuth to have run",
      );
    }

    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    if (!idempotencyKey) {
      throw new AppError(
        409,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header is required for remote write actions",
      );
    }

    if (idempotencyKey.length < 8 || idempotencyKey.length > 256) {
      throw new AppError(
        409,
        "IDEMPOTENCY_KEY_INVALID",
        "Idempotency-Key must be between 8 and 256 characters",
      );
    }

    const requestHash = hashRequest(request.method, request.url, request.body);
    const expiresAt = new Date(Date.now() + DEFAULT_IDEMPOTENCY_TTL_MS).toISOString();

    const { row, created } = idempotencyRepo.getOrCreateIdempotencyKey({
      habitatId: ctx.habitatId,
      remoteParticipantId: ctx.participant.id,
      remoteCredentialId: ctx.credentialId,
      action,
      idempotencyKey,
      requestHash,
      expiresAt,
    });

    if (!created) {
      // Existing record — check if it matches the current request
      if (row.requestHash !== requestHash) {
        throw new AppError(
          409,
          "IDEMPOTENCY_KEY_MISMATCH",
          "Idempotency-Key was used with a different request body",
        );
      }

      if (row.status === "pending") {
        throw new AppError(
          409,
          "IDEMPOTENCY_KEY_IN_FLIGHT",
          "Idempotency-Key is currently in-flight; retry shortly",
        );
      }

      if (row.status === "completed" && row.responseStatus !== null) {
        const storedRaw = row.responseBody;
        let storedBody: unknown;
        if (storedRaw === null) {
          storedBody = {};
        } else {
          try {
            storedBody = JSON.parse(storedRaw);
          } catch {
            storedBody = storedRaw;
          }
        }
        const res = _reply;
        res.header("X-Orcy-Idempotent-Replay", "true");
        res.code(row.responseStatus).send(storedBody);
        return;
      }

      if (row.status === "failed") {
        throw new AppError(
          409,
          "IDEMPOTENCY_KEY_PRIOR_FAILURE",
          row.errorMessage ?? "Prior request with this Idempotency-Key failed",
        );
      }
    }

    // First-time request — attach the record id so the route handler can
    // explicitly complete or fail the record.
    request.remoteIdempotency = {
      key: idempotencyKey,
      recordId: row.id,
      isReplay: false,
      action,
    };
  };
}

/**
 * Mark an idempotency record as completed with the given response. Call this
 * from the route handler in a try block after a successful operation.
 */
export function completeRemoteIdempotency(
  request: FastifyRequest,
  responseStatus: number,
  responseBody: Record<string, unknown>,
): void {
  if (!request.remoteIdempotency) return;
  idempotencyRepo.completeIdempotencyKey(
    request.remoteIdempotency.recordId,
    responseStatus,
    responseBody,
  );
}

/**
 * Mark an idempotency record as failed with the given error. Call this from
 * the route handler in a catch/finally block so retries see the failure.
 */
export function failRemoteIdempotency(
  request: FastifyRequest,
  errorMessage: string,
  responseStatus?: number,
): void {
  if (!request.remoteIdempotency) return;
  idempotencyRepo.failIdempotencyKey(
    request.remoteIdempotency.recordId,
    errorMessage,
    responseStatus,
  );
}
