import { getDb } from "../db/index.js";
import { agents, tasks } from "../db/schema/index.js";
import { eq, and, not, lt, ne, sql, inArray, or, isNotNull } from "drizzle-orm";

import type { Agent, AgentType, AgentDomain, AgentStatus } from "../models/index.js";
import { v4 as uuid } from "uuid";
import { createHash, randomBytes } from "crypto";
import {
  repositoryCreateError,
  assertFound,
  repositoryUpdateError,
  repositoryTransactionError,
} from "../errors/repository.js";
import { AgentTeardownReferencesRemainError, isAppError } from "../errors.js";

export interface CreateAgentInput {
  name: string;
  type: AgentType;
  domain: AgentDomain;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateAgentInput {
  name?: string;
  type?: AgentType;
  domain?: AgentDomain;
  capabilities?: string[];
  status?: AgentStatus;
  metadata?: Record<string, unknown>;
  rateLimitPerMinute?: number | null;
}

type AgentPublic = Omit<Agent, "apiKeyHash">;

const agentPublicFields = {
  id: agents.id,
  name: agents.name,
  type: agents.type,
  domain: agents.domain,
  capabilities: agents.capabilities,
  status: agents.status,
  currentTaskId: agents.currentTaskId,
  rateLimitPerMinute: agents.rateLimitPerMinute,
  createdAt: agents.createdAt,
  lastHeartbeat: agents.lastHeartbeat,
  metadata: agents.metadata,
} as const;

export function createAgent(input: CreateAgentInput): { agent: AgentPublic; plainApiKey: string } {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  const plainApiKey = `${id}-${randomBytes(16).toString("hex")}`;
  const apiKeyHash = hashApiKey(plainApiKey);

  try {
    db.insert(agents)
      .values({
        id,
        name: input.name,
        type: input.type,
        domain: input.domain,
        capabilities: input.capabilities ?? [],
        status: "idle",
        apiKey: apiKeyHash,
        createdAt: now,
        lastHeartbeat: now,
        metadata: input.metadata ?? {},
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("agent", err as Error, id);
  }

  return { agent: assertFound(getAgentById(id), "agent", id), plainApiKey };
}

export function getAgentById(id: string): AgentPublic | null {
  const db = getDb();
  const rows = db.select(agentPublicFields).from(agents).where(eq(agents.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function listAgents(): AgentPublic[] {
  const db = getDb();
  return db
    .select(agentPublicFields)
    .from(agents)
    .orderBy(sql`${agents.createdAt} DESC`)
    .all();
}

export function getAgentByName(name: string): AgentPublic | null {
  const db = getDb();
  const rows = db.select(agentPublicFields).from(agents).where(eq(agents.name, name)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getAgentByApiKey(plainKey: string): AgentPublic | null {
  const db = getDb();
  const hash = hashApiKey(plainKey);
  const rows = db.select(agentPublicFields).from(agents).where(eq(agents.apiKey, hash)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function updateAgent(id: string, input: UpdateAgentInput): AgentPublic | null {
  const db = getDb();
  const updates: Partial<typeof agents.$inferInsert> = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.type !== undefined) updates.type = input.type;
  if (input.domain !== undefined) updates.domain = input.domain;
  if (input.capabilities !== undefined) updates.capabilities = input.capabilities;
  if (input.status !== undefined) updates.status = input.status;
  if (input.metadata !== undefined) updates.metadata = input.metadata;
  if (input.rateLimitPerMinute !== undefined) updates.rateLimitPerMinute = input.rateLimitPerMinute;

  if (Object.keys(updates).length === 0) return getAgentById(id);

  try {
    db.update(agents).set(updates).where(eq(agents.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("agent", err as Error, id);
  }
  return getAgentById(id);
}

/**
 * PRE-DELETE assertion + the agent-row DELETE, on the CALLER's open writer
 * transaction (the atomic agent-deletion composition owns the tx). The
 * `tasks.assignedAgentId` / `tasks.delegatedToAgentId` FKs are NO-ACTION, so
 * the agent row can only die with ZERO remaining task references: this makes
 * that precondition an explicit, checked contract instead of a raw FK 500.
 * Runs BEFORE the DELETE statement while the row still lives, under the
 * caller's writer lock, so no claim or delegation can interleave between
 * the assert and the delete — a missed reference aborts the whole caller
 * transaction (the agent and every task row roll back together).
 *
 * The daemon-era raw straggler reset (bulk claimed→pending rewrite) is
 * deliberately GONE: releases are the release bundle's job
 * (`releaseTaskWithEffectsWithClient` inside the same outer tx); this
 * function only verifies the composition actually cleared every reference.
 */
export function deleteAgentWithClient(tx: ReturnType<typeof getDb>, id: string): void {
  const assigned = tx
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.assignedAgentId, id))
    .get() as { count: number | string } | undefined;
  const delegated = tx
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.delegatedToAgentId, id))
    .get() as { count: number | string } | undefined;
  const assignedRefs = Number(assigned?.count ?? 0);
  const delegatedRefs = Number(delegated?.count ?? 0);
  if (assignedRefs > 0 || delegatedRefs > 0) {
    // Typed domain refusal — the composition's own invariant guard, thrown
    // ahead of the raw FK violation so callers see the structured contract.
    throw new AgentTeardownReferencesRemainError({ assignedRefs, delegatedRefs });
  }
  tx.delete(agents).where(eq(agents.id, id)).run();
}

/**
 * Deletes an {@link Agent} that holds NO task references, in one
 * `BEGIN IMMEDIATE` transaction (assert + delete). Callers deleting an agent
 * that may hold tasks MUST go through `agentService.deleteAgent` — the
 * atomic composition that releases holdings, unassigns terminal rows,
 * clears inbound delegation offers, and only then reaches this teardown.
 */
export function deleteAgent(id: string): void {
  const db = getDb();

  try {
    db.transaction((tx) => deleteAgentWithClient(tx, id), { behavior: "immediate" });
  } catch (err) {
    // Typed domain refusals rethrow unwrapped — never masked by a generic
    // repository error.
    if (isAppError(err)) throw err;
    throw repositoryTransactionError("agent", err as Error, id);
  }
}

export function heartbeat(agentId: string, taskId?: string): AgentPublic | null {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    if (taskId) {
      db.update(agents)
        .set({
          lastHeartbeat: now,
          currentTaskId: taskId,
          status: "working",
        })
        .where(eq(agents.id, agentId))
        .run();
    } else {
      db.update(agents)
        .set({
          lastHeartbeat: now,
          status: "idle",
          currentTaskId: null,
        })
        .where(eq(agents.id, agentId))
        .run();
    }
  } catch (err) {
    throw repositoryUpdateError("agent", err as Error, agentId);
  }

  return getAgentById(agentId);
}

export function getStaleAgents(thresholdMinutes: number = 30): AgentPublic[] {
  const db = getDb();
  const threshold = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
  return db
    .select(agentPublicFields)
    .from(agents)
    .where(and(lt(agents.lastHeartbeat, threshold), not(eq(agents.status, "offline"))))
    .all();
}

export function setAgentOffline(agentId: string): void {
  const db = getDb();
  try {
    db.update(agents)
      .set({
        status: "offline",
        currentTaskId: null,
      })
      .where(eq(agents.id, agentId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("agent", err as Error, agentId);
  }
}

/**
 * `datetime()`-normalized staleness predicate — malformed/absent timestamps
 * normalize to NULL and are excluded (never lex-compared garbage). Shared by
 * the sweep's candidacy query and its CAS writes.
 */
const stillStaleHeartbeatSql = (thresholdIso: string) => sql`
  datetime(${agents.lastHeartbeat}) IS NOT NULL
  AND datetime(${agents.lastHeartbeat}) < datetime(${thresholdIso})
`;

/**
 * Stale-sweep candidacy (REC-06, broader than {@link getStaleAgents}): stale
 * heartbeat AND (not already offline OR a retained `currentTaskId`). An
 * already-offline agent with a retained pointer — the budget-refusal
 * retention shape — re-enters candidacy so a later ceiling raise can retry;
 * an eternally-offline taskless agent is never rescanned.
 */
export function getStaleSweepCandidates(thresholdMinutes: number = 30): AgentPublic[] {
  const db = getDb();
  const threshold = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
  return db
    .select(agentPublicFields)
    .from(agents)
    .where(
      and(
        stillStaleHeartbeatSql(threshold),
        or(not(eq(agents.status, "offline")), isNotNull(agents.currentTaskId)),
      ),
    )
    .all();
}

/**
 * Sweep-only offline transition (the general {@link setAgentOffline} stays
 * untouched for every other caller): sets `offline` WITHOUT clearing
 * `currentTaskId`, CAS-fenced on the stale heartbeat so a revived agent is
 * never flipped offline by a stale observation. Returns EXACT landed truth
 * via `UPDATE ... RETURNING` (both drivers — the receipt-ack pattern):
 * `true` iff THIS statement flipped a not-already-offline row, so a
 * concurrent writer's outcome is never certified as ours and an
 * already-offline row matches nothing (no duplicate flip / SSE).
 */
export function markAgentOfflineKeepingTask(agentId: string, thresholdIso: string): boolean {
  const db = getDb();
  try {
    const flipped = db
      .update(agents)
      .set({ status: "offline" })
      .where(
        and(
          eq(agents.id, agentId),
          ne(agents.status, "offline"),
          stillStaleHeartbeatSql(thresholdIso),
        ),
      )
      .returning({ id: agents.id })
      .all();
    return Array.isArray(flipped) && flipped.length > 0;
  } catch (err) {
    throw repositoryUpdateError("agent", err as Error, agentId);
  }
}

/**
 * Conditional pointer cleanup, ATOMIC under one `BEGIN IMMEDIATE` (the same
 * write authority as the claim path): re-reads the agent fences AND the
 * task's current ownership INSIDE the tx, then clears only when no live
 * claim exists. The predicate per review F1 —
 *   agent id ∧ observed `currentTaskId` ∧ still-stale heartbeat ∧ NOT
 *   (task claimed/in_progress ∧ assigned to THIS agent).
 * A task re-claimed by the agent in the commit→cleanup gap (E2 minted; the
 * claim authority writes nothing to `agents`) RETAINS the pointer — the
 * next tick's full guard path (in-tx heartbeat/pointer/owner + epoch fence)
 * decides the release per the sweep's contract. The lock serializes the
 * race: a claim committed first is visible in-tx; a claim arriving later
 * blocks until after our clear commits. Every cleanup shape — missing task,
 * terminal, foreign, pending-unowned residue — carries no live claim, so
 * all still clear. Returns whether the pointer is now clear.
 */
export function clearAgentTaskPointerIfStale(
  agentId: string,
  taskId: string,
  thresholdIso: string,
): boolean {
  const db = getDb();
  try {
    return db.transaction(
      (tx) => {
        const agentRow = tx
          .select({ currentTaskId: agents.currentTaskId, lastHeartbeat: agents.lastHeartbeat })
          .from(agents)
          .where(eq(agents.id, agentId))
          .get() as { currentTaskId: string | null; lastHeartbeat: string | null } | undefined;
        if (!agentRow || agentRow.currentTaskId !== taskId) return false; // moved/absent
        const beat = Date.parse(agentRow.lastHeartbeat ?? "");
        if (Number.isNaN(beat) || beat >= Date.parse(thresholdIso)) return false; // revived/bad

        // F1: a live claim owned by THIS agent forbids the clear.
        const liveClaim = tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.assignedAgentId, agentId),
              sql`${tasks.status} IN ('claimed', 'in_progress')`,
            ),
          )
          .get();
        if (liveClaim) return false;

        tx.update(agents)
          .set({ currentTaskId: null })
          .where(and(eq(agents.id, agentId), eq(agents.currentTaskId, taskId)))
          .run();
        const after = tx
          .select({ ptr: agents.currentTaskId })
          .from(agents)
          .where(eq(agents.id, agentId))
          .get();
        return after?.ptr == null;
      },
      { behavior: "immediate" },
    );
  } catch (err) {
    throw repositoryUpdateError("agent", err as Error, agentId);
  }
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
