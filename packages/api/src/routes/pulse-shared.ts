import type { FastifyRequest } from "fastify";

export { VALID_SIGNAL_TYPES, type SignalType } from "../services/pulseService.js";

export function getCallerInfo(
  request: FastifyRequest,
): { type: "human" | "agent"; id: string } | null {
  if (request.agent) return { type: "agent", id: request.agent.id };
  if (request.user) return { type: "human", id: request.user.id };
  return null;
}
