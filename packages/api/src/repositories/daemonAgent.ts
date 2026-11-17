import { getDb } from "../db/index.js";
import { daemonAgents } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { AGENT_TYPES } from "@orcy/shared";
import type { AgentType } from "../models/index.js";
import { logger } from "../lib/logger.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

export interface CreateDaemonAgentInput {
  daemonId: string;
  agentId: string;
  cliType: AgentType;
  cliVersion: string | null;
  cliPath: string;
}

export interface DaemonAgentRow {
  id: string;
  daemonId: string;
  agentId: string;
  cliType: AgentType;
  cliVersion: string | null;
  cliPath: string;
  status: string;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const AGENT_TYPE_SET: ReadonlySet<string> = new Set(AGENT_TYPES);

/**
 * `daemon_agents.cli_type` has no physical CHECK (0090 covered `agents.type`
 * only), so a legacy or directly-written foreign value can sit in the column.
 * Validate before asserting the `AgentType`-typed row shape: skip the row as
 * not-a-daemon-agent and log it, so the poll path never claims tasks for a
 * CLI with no adapter (previously one task was claimed and failed per tick).
 */
function toDaemonAgentRow(row: DaemonAgentRow): DaemonAgentRow | null {
  if (!AGENT_TYPE_SET.has(row.cliType)) {
    logger.warn(
      { cliType: row.cliType, daemonId: row.daemonId, agentId: row.agentId },
      "daemon_agents row has an unsupported cli_type; skipping row",
    );
    return null;
  }
  return row;
}

const daemonAgentFields = {
  id: daemonAgents.id,
  daemonId: daemonAgents.daemonId,
  agentId: daemonAgents.agentId,
  cliType: daemonAgents.cliType,
  cliVersion: daemonAgents.cliVersion,
  cliPath: daemonAgents.cliPath,
  status: daemonAgents.status,
  lastSeenAt: daemonAgents.lastSeenAt,
  createdAt: daemonAgents.createdAt,
  updatedAt: daemonAgents.updatedAt,
} as const;

export function createDaemonAgent(input: CreateDaemonAgentInput): DaemonAgentRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(daemonAgents)
      .values({
        id,
        daemonId: input.daemonId,
        agentId: input.agentId,
        cliType: input.cliType,
        cliVersion: input.cliVersion,
        cliPath: input.cliPath,
        status: "idle",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("daemonAgent", err as Error, id);
  }

  const agent = getDaemonAgentById(id);
  if (!agent) throw repositoryNotFoundError("daemonAgent", id);
  return agent;
}

export function getDaemonAgentById(id: string): DaemonAgentRow | null {
  const db = getDb();
  const rows = db.select(daemonAgentFields).from(daemonAgents).where(eq(daemonAgents.id, id)).all();
  const row = rows.length > 0 ? rows[0] : null;
  return row === null ? null : toDaemonAgentRow(row);
}

export function getDaemonAgentsByDaemonId(daemonId: string): DaemonAgentRow[] {
  const db = getDb();
  return db
    .select(daemonAgentFields)
    .from(daemonAgents)
    .where(eq(daemonAgents.daemonId, daemonId))
    .all()
    .map(toDaemonAgentRow)
    .filter((row): row is DaemonAgentRow => row !== null);
}

export function getDaemonAgentByAgentId(agentId: string): DaemonAgentRow | null {
  const db = getDb();
  const rows = db
    .select(daemonAgentFields)
    .from(daemonAgents)
    .where(eq(daemonAgents.agentId, agentId))
    .all();
  const row = rows.length > 0 ? rows[0] : null;
  return row === null ? null : toDaemonAgentRow(row);
}

export function updateDaemonAgentStatus(
  id: string,
  status: "idle" | "working" | "offline",
): DaemonAgentRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(daemonAgents)
      .set({ status, lastSeenAt: now, updatedAt: now })
      .where(eq(daemonAgents.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("daemonAgent", err as Error, id);
  }
  return getDaemonAgentById(id);
}

export function isAgentOwnedByDaemon(agentId: string, daemonId: string): boolean {
  const db = getDb();
  const rows = db
    .select({ id: daemonAgents.id })
    .from(daemonAgents)
    .where(and(eq(daemonAgents.agentId, agentId), eq(daemonAgents.daemonId, daemonId)))
    .all();
  return rows.length > 0;
}
