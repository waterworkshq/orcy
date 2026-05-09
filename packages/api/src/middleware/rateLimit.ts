import type { FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../db/index.js';
import { agents } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

interface RateLimitEntry {
  timestamps: number[];
}

const DEFAULT_AGENT_LIMIT = 60;
const DEFAULT_HUMAN_LIMIT = 500;
const WINDOW_MS = 60_000;

const store = new Map<string, RateLimitEntry>();

function getAgentRateLimit(agentId: string): number {
  try {
    const db = getDb();
    const rows = db.select({ rateLimitPerMinute: agents.rateLimitPerMinute })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
      .all();
    if (rows.length > 0 && rows[0].rateLimitPerMinute != null) {
      return rows[0].rateLimitPerMinute;
    }
  } catch (err) {
    logger.warn({ err, agentId }, 'Failed to query agent rate limit, using default');
  }
  return DEFAULT_AGENT_LIMIT;
}

function getKey(request: FastifyRequest): string {
  const apiKey = request.headers['x-agent-api-key'] as string | undefined;
  if (apiKey) return `agent:${apiKey}`;
  const authHeader = request.headers.authorization;
  if (authHeader) return `human:${authHeader}`;
  return `ip:${request.ip}`;
}

function getLimit(request: FastifyRequest): number {
  if (request.agent) return getAgentRateLimit(request.agent.id);
  if (request.user) return DEFAULT_HUMAN_LIMIT;
  return DEFAULT_AGENT_LIMIT;
}

function cleanup(): void {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter(ts => ts > cutoff);
    if (entry.timestamps.length === 0) store.delete(key);
  }
}

setInterval(cleanup, 60_000);

export async function perAgentRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const key = getKey(request);
  const limit = getLimit(request);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);
  entry.timestamps.push(now);

  const remaining = Math.max(0, limit - entry.timestamps.length);
  reply.header('X-RateLimit-Limit', limit);
  reply.header('X-RateLimit-Remaining', remaining);

  if (entry.timestamps.length > limit) {
    const oldestInWindow = entry.timestamps[0];
    const retryAfterSeconds = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);
    reply.header('Retry-After', retryAfterSeconds);
    reply.code(429).send({ error: 'Too many requests', code: 'RATE_LIMITED' });
  }
}
