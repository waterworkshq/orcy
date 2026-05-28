import type { FastifyRequest, FastifyReply } from "fastify";
import { getDaemonByTokenHash } from "../repositories/daemon.js";
import { hashDaemonToken } from "../lib/daemonToken.js";
import { unauthorized } from "../errors.js";

declare module "fastify" {
  interface FastifyRequest {
    daemon?: {
      id: string;
      name: string;
      hostname: string;
      status: string;
      maxConcurrent: number;
    };
  }
}

export async function daemonAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = request.headers["x-daemon-token"] as string | undefined;

  if (!token) {
    throw unauthorized("Missing X-Daemon-Token header", "DAEMON_UNAUTHORIZED");
  }

  const hash = hashDaemonToken(token);
  const daemon = getDaemonByTokenHash(hash);

  if (!daemon) {
    throw unauthorized("Invalid daemon token", "DAEMON_INVALID_TOKEN");
  }

  request.daemon = {
    id: daemon.id,
    name: daemon.name,
    hostname: daemon.hostname,
    status: daemon.status,
    maxConcurrent: daemon.maxConcurrent,
  };
}
