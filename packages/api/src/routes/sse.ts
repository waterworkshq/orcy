import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { authenticateRealtime, authorizeHabitatAccess } from "../middleware/realtimeAuth.js";
import { isRemoteConnectionValid } from "../middleware/remoteAuth.js";
import type { SSEEvent } from "../models/index.js";

const SSE_REVALIDATION_INTERVAL_MS = 30_000;

export async function sseRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { habitatId: string } }>(
    "/habitats/:habitatId/stream",
    { preHandler: [authenticateRealtime, authorizeHabitatAccess] },
    async (request: FastifyRequest<{ Params: { habitatId: string } }>, reply: FastifyReply) => {
      const habitatId = request.params.habitatId;
      const remoteCtx = request.remoteParticipant;

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");

      const encoder = new TextEncoder();

      const unsubscribe = sseBroadcaster.subscribe(habitatId, (event: SSEEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        reply.raw.write(encoder.encode(data));
      });

      reply.raw.write(
        encoder.encode(`data: ${JSON.stringify({ type: "connected", data: { habitatId } })}\n\n`),
      );

      // Periodic re-validation for remote connections — revoke/freeze can happen
      // mid-stream, so we re-check credential, participant, pod, and grant
      // state on an interval. Local connections (no remoteCtx) are skipped.
      const revalidationInterval = setInterval(() => {
        if (!remoteCtx) return;
        const validation = isRemoteConnectionValid(remoteCtx);
        if (!validation.valid) {
          const logger = request.log ?? console;
          logger.warn(
            {
              participantId: remoteCtx.participant.id,
              podId: remoteCtx.pod.id,
              habitatId: remoteCtx.habitatId,
              code: validation.code,
              internalReason: validation.reason,
            },
            "remote SSE connection invalidated by periodic re-validation",
          );
          // Send a final event so the client knows the stream is ending
          const disconnectEvent = `data: ${JSON.stringify({ type: "disconnected", data: { reason: validation.code } })}\n\n`;
          reply.raw.write(encoder.encode(disconnectEvent));
          reply.raw.end();
          clearInterval(revalidationInterval);
          unsubscribe();
        }
      }, SSE_REVALIDATION_INTERVAL_MS);

      // Unref so the interval doesn't keep the event loop alive after disconnect
      if (typeof revalidationInterval.unref === "function") {
        revalidationInterval.unref();
      }

      const cleanup = () => {
        clearInterval(revalidationInterval);
        unsubscribe();
      };

      request.raw.on("close", cleanup);
      request.raw.on("error", cleanup);
    },
  );
}
