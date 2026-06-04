import type { FastifyRequest, FastifyReply } from "fastify";
import * as agentService from "../services/agentService.js";
import { extractAndVerifyJwt, getJwtSecret, setJwtSecret } from "./jwt-verification.js";
import { unauthorized, forbidden } from "../errors.js";
import { setAuditActor } from "../services/auditProvenanceContext.js";

export { getJwtSecret, setJwtSecret };

/** Role assigned to a human user in the system. */
export type HumanRole = "admin" | "editor" | "viewer";

declare module "fastify" {
  interface FastifyRequest {
    agent?: Awaited<ReturnType<typeof agentService.getAgentByApiKey>>;
    user?: { id: string; username: string; role: HumanRole; type: "human" };
  }
}

/**
 * Fastify middleware that authenticates an agent request using the X-Agent-API-Key header.
 * Sets request.agent on success, or returns 401.
 */
export async function agentAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const apiKey = request.headers["x-agent-api-key"] as string | undefined;

  if (!apiKey) {
    throw unauthorized("Missing X-Agent-API-Key header", "UNAUTHORIZED");
  }

  const agent = agentService.getAgentByApiKey(apiKey);
  if (!agent) {
    throw unauthorized("Invalid API key", "INVALID_API_KEY");
  }

  request.agent = agent;
  setAuditActor("agent", agent.id);
}

/**
 * Fastify middleware that authenticates a human user via a Bearer JWT.
 * Sets request.user on success, or returns 401.
 */
export async function humanAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const { user, error } = extractAndVerifyJwt(request, { allowBearer: true });
  if (error) {
    throw unauthorized(error.message, error.code ?? "UNAUTHORIZED");
  }
  request.user = { ...user!, role: user!.role as HumanRole };
  setAuditActor("human", user!.id);
}

/**
 * Fastify middleware that validates the X-Registration-Token header.
 * Returns 403 if a token is configured but does not match.
 */
export async function registrationAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const secret = process.env.ORCY_REGISTRATION_TOKEN;
  if (!secret) return;

  const token = request.headers["x-registration-token"] as string | undefined;
  if (!token || token !== secret) {
    throw forbidden("Invalid registration token", "REGISTRATION_TOKEN_INVALID");
  }
}

export async function agentOrHumanAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const apiKey = request.headers["x-agent-api-key"] as string | undefined;
  if (apiKey) {
    const agent = agentService.getAgentByApiKey(apiKey);
    if (agent) {
      request.agent = agent;
      setAuditActor("agent", agent.id);
      return;
    }
    throw unauthorized("Invalid API key", "INVALID_API_KEY");
  }

  const { user, error } = extractAndVerifyJwt(request, { allowBearer: true });
  if (error) {
    throw unauthorized(error.message, error.code ?? "UNAUTHORIZED");
  }
  request.user = { ...user!, role: user!.role as HumanRole };
  setAuditActor("human", user!.id);
}
