import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { authorizeHabitatAccess } from "../middleware/realtimeAuth.js";
import {
  REMOTE_STREAM_FORBIDDEN_CODE,
  REMOTE_STREAM_FORBIDDEN_MESSAGE,
  REMOTE_STREAM_INTERNAL_CODE,
  REMOTE_STREAM_INTERNAL_MESSAGE,
  guardRemoteStreamAdmission,
  refreshRemoteStreamRead,
  type RemoteStreamAnchors,
} from "../middleware/remoteAuth.js";
import { inheritAuthPolicy } from "../authPolicy.js";
import type { SSEEvent } from "../models/index.js";
import { forbidden, AppError } from "../errors.js";
import { isTargetVisibleToParticipant } from "../services/sharedGrantVisibilityService.js";
import {
  buildRemoteEntityChanged,
  extractRemotePrimaryTarget,
  type RemotePrimaryTarget,
} from "../services/remoteStreamProjection.js";
import { getTaskByIdExact } from "../repositories/taskCrud.js";
import { getMissionByIdWithClient } from "../repositories/mission.js";
import { getDb } from "../db/index.js";

const SSE_REVALIDATION_INTERVAL_MS = 30_000;

/**
 * One generic midstream disconnect code. The specific reason (which identity
 * relationship failed, which grant expired) is a server-side log detail only:
 * telling the client which check failed would be a probing oracle.
 */
const REMOTE_STREAM_DISCONNECT_REASON = "REMOTE_STREAM_CLOSED";

/**
 * Route-owned admission mark.
 *
 * Fastify runs `onRequest` before every preHandler, including the
 * policy-installed authentication guard — which the route cannot wrap, because
 * the installer PREPENDS it to this route's own preHandler array. Marking the
 * request here is therefore the only way to give the guard a remote-stream
 * scope, and it does so without teaching the policy installer a URL rule.
 *
 * The value is assigned here and read from `request.remoteStreamAdmission`. It
 * is never derived from a header, body, or query value, it is absent by default
 * on every other route, and it is not a global flag.
 *
 * Callback style with an explicit `done()` — the shape this repository already
 * uses for its `onRequest` hooks. Fastify's hook runner advances only on a
 * returned thenable or a `done()` call, so a silently-returning sync hook would
 * stall the request instead of completing it.
 */
function markRemoteStreamAdmission(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  request.remoteStreamAdmission = true;
  done();
}

/**
 * Resolve the extracted target against CURRENT persisted rows and its ACTUAL
 * Habitat, returning null whenever it cannot be confirmed.
 *
 * Both the primary target and the Task→Mission ancestry are read by exact
 * persisted id. `getTaskById` normalizes the legacy `feat-` prefix, so an alias
 * spelling could resolve a different row (or resolve nothing and suppress the
 * row that does exist) — the exact seam avoids answering about the wrong
 * identity. Mission lookup reuses the existing supplied-client exact read, which
 * performs no `mission-` normalization.
 */
function resolveLiveTarget(
  target: RemotePrimaryTarget,
  habitatId: string,
): RemotePrimaryTarget | null {
  if (target.targetType === "mission") {
    const mission = getMissionByIdWithClient(getDb(), target.targetId);
    if (!mission) return null;
    if (mission.habitatId !== habitatId) return null;
    return { targetType: "mission", targetId: target.targetId };
  }

  const task = getTaskByIdExact(target.targetId);
  if (!task) return null;
  const mission = getMissionByIdWithClient(getDb(), task.missionId);
  if (!mission) return null;
  if (mission.habitatId !== habitatId) return null;
  return { targetType: "task", targetId: target.targetId };
}

export async function sseRoutes(fastify: FastifyInstance): Promise<void> {
  // Homogeneous realtime scope: every stream authenticates its actor (human
  // token, agent key, or remote participant key) through the policy-installed
  // guard; habitat authorization remains a separate later middleware.
  inheritAuthPolicy(fastify, "realtime");

  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/stream",
    { onRequest: markRemoteStreamAdmission, preHandler: [authorizeHabitatAccess] },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, reply: FastifyReply) => {
      const habitatId = request.params.habitatId;
      const remoteCtx = request.remoteParticipant;
      const encoder = new TextEncoder();

      // ---------------------------------------------------------------------
      // Remote stream read gate — BEFORE any header, subscription, or frame.
      //
      // Stronger than the generic connection check the shared preHandler ran:
      // read authority requires an EFFECTIVELY ACTIVE grant carrying `read` for
      // the freshly loaded standing, while the generic check is deliberately
      // broader and accepts grace. Grace never buys a read or a stream.
      // ---------------------------------------------------------------------
      let remoteAnchors: RemoteStreamAnchors | null = null;
      if (remoteCtx) {
        const anchors: RemoteStreamAnchors = {
          credentialId: remoteCtx.credentialId,
          participantId: remoteCtx.participant.id,
          podId: remoteCtx.pod.id,
          habitatId: remoteCtx.habitatId,
        };
        let refresh;
        try {
          refresh = refreshRemoteStreamRead(anchors, Date.now());
        } catch (err) {
          // Guarded: a failing logger must not replace the mapped generic 500
          // with its own exception.
          try {
            (request.log ?? console).error({ err }, "remote SSE read gate failed");
          } catch {
            // ignore logger faults
          }
          // Explicit coded AppError (see the matching comment in
          // remoteAuth.ts): internalError would pin the code to
          // INTERNAL_ERROR and demote the intended code to `details`.
          throw new AppError(500, REMOTE_STREAM_INTERNAL_CODE, REMOTE_STREAM_INTERNAL_MESSAGE);
        }
        if (!refresh.valid) {
          try {
            (request.log ?? console).warn(
              { code: refresh.code, internalReason: refresh.reason },
              "remote SSE read gate denied",
            );
          } catch {
            // ignore logger faults
          }
          throw forbidden(REMOTE_STREAM_FORBIDDEN_MESSAGE, REMOTE_STREAM_FORBIDDEN_CODE);
        }
        remoteAnchors = anchors;
      }

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");

      const writeFrame = (payload: unknown): void => {
        reply.raw.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      let revalidationInterval: ReturnType<typeof setInterval> | undefined;
      let cleanedUp = false;
      let unsubscribe: () => void = () => {};

      /**
       * Terminate a remote stream: one generic control frame, then end and
       * release. Every step is independently guarded so a failing write, a
       * failing `end`, a failing logger, or a failing earlier step cannot leave
       * the subscription or the interval retained, and no secondary exception
       * escapes into the broadcaster.
       */
      const endRemoteStream = (internalCode: string): void => {
        try {
          (request.log ?? console).warn({ code: internalCode }, "remote SSE stream ended");
        } catch {
          // A failing logger must not block cleanup.
        }
        if (cleanedUp) return;
        try {
          writeFrame({ type: "disconnected", data: { reason: REMOTE_STREAM_DISCONNECT_REASON } });
        } catch {
          // A failing control write must not block cleanup.
        }
        try {
          reply.raw.end();
        } catch {
          // A failing end must not block cleanup.
        }
        cleanup();
      };

      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        try {
          if (revalidationInterval) clearInterval(revalidationInterval);
        } catch {
          // Independently guarded from the unsubscribe below.
        }
        try {
          unsubscribe();
        } catch {
          // Independently guarded from the interval above.
        }
      };

      if (remoteAnchors) {
        const anchors = remoteAnchors;
        unsubscribe = sseBroadcaster.subscribe(habitatId, (event: SSEEvent) => {
          // One clock value for this whole event decision, shared by the
          // identity refresh and the visibility check.
          const now = Date.now();

          // Refresh BEFORE deciding visibility: a globally invalid or
          // read-ineligible connection closes even when this particular event
          // would have been suppressed anyway. The connection-opening grant
          // snapshot is never reused.
          let refresh;
          try {
            refresh = refreshRemoteStreamRead(anchors, now);
          } catch (err) {
            try {
              (request.log ?? console).error({ err }, "remote SSE event refresh failed");
            } catch {
              // ignore logger faults
            }
            endRemoteStream("REFRESH_FAULT");
            return;
          }
          if (!refresh.valid || !refresh.ctx) {
            endRemoteStream(refresh.code);
            return;
          }
          const ctx = refresh.ctx;

          let target: RemotePrimaryTarget | null;
          try {
            target = extractRemotePrimaryTarget(event);
          } catch (err) {
            try {
              (request.log ?? console).error({ err }, "remote SSE extraction failed");
            } catch {
              // ignore logger faults
            }
            endRemoteStream("EXTRACTION_FAULT");
            return;
          }
          // Closed allowlist: unknown types, deletions, clones, mentions,
          // watchers, Pulse, presence and malformed payloads are suppressed.
          if (!target) return;

          let resolved: RemotePrimaryTarget | null;
          try {
            resolved = resolveLiveTarget(target, habitatId);
          } catch (err) {
            try {
              (request.log ?? console).error({ err }, "remote SSE target resolution failed");
            } catch {
              // ignore logger faults
            }
            endRemoteStream("RESOLUTION_FAULT");
            return;
          }
          // Missing, dangling, or foreign-Habitat target: suppress this event
          // only, with no target-specific denial frame (no existence oracle).
          if (!resolved) return;

          // Split grants are permitted: `read` may have come from one
          // effectively active grant and target visibility from another. Each is
          // independently relevant to this participant/pod and Habitat. Mission
          // visibility is never inferred for a child Task.
          //
          // The visibility predicate performs its own database reads (allowlist
          // targets, the rule row, and the task snapshot). Those must be inside
          // the callback's fault mechanism for the same reason target
          // resolution is: an uncontained throw would escape the broadcaster
          // callback into publish/publishToClients, skipping later subscribers
          // and, on `publish`, the domain fan-out, while leaving this
          // subscription and its interval retained.
          let visibility: ReturnType<typeof isTargetVisibleToParticipant>;
          try {
            visibility = isTargetVisibleToParticipant(ctx, resolved.targetType, resolved.targetId, {
              grants: ctx.grants,
              now,
            });
          } catch (err) {
            // A failing logger must not be able to prevent termination and
            // independent cleanup, so the log is itself guarded.
            try {
              (request.log ?? console).error({ err }, "remote SSE visibility check failed");
            } catch {
              // ignore logger faults
            }
            endRemoteStream("VISIBILITY_FAULT");
            return;
          }
          if (!visibility.visible) return;

          try {
            // Built from scratch — the input event is never serialized or spread.
            writeFrame(buildRemoteEntityChanged(resolved.targetType, resolved.targetId));
          } catch (err) {
            try {
              (request.log ?? console).error({ err }, "remote SSE write failed");
            } catch {
              // ignore logger faults
            }
            endRemoteStream("WRITE_FAULT");
          }
        });
      } else {
        // Local human/agent stream: raw Habitat payload, unchanged.
        unsubscribe = sseBroadcaster.subscribe(habitatId, (event: SSEEvent) => {
          writeFrame(event);
        });
      }

      // Lifecycle ownership is installed BEFORE the first frame, so a failing
      // connected-frame write still releases the subscription and the interval.
      revalidationInterval = setInterval(() => {
        if (!remoteAnchors) return;
        let refresh;
        try {
          refresh = refreshRemoteStreamRead(remoteAnchors, Date.now());
        } catch {
          endRemoteStream("REFRESH_FAULT");
          return;
        }
        if (!refresh.valid) {
          endRemoteStream(refresh.code);
        }
      }, SSE_REVALIDATION_INTERVAL_MS);

      // Unref so the interval doesn't keep the event loop alive after disconnect
      if (typeof revalidationInterval.unref === "function") {
        revalidationInterval.unref();
      }

      request.raw.on("close", cleanup);
      request.raw.on("error", cleanup);

      try {
        writeFrame({ type: "connected", data: { habitatId } });
      } catch (err) {
        try {
          (request.log ?? console).error({ err }, "SSE connected frame write failed");
        } catch {
          // ignore logger faults
        }
        cleanup();
        throw err;
      }
    },
  );
}
