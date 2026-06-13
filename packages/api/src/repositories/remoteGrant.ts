import { getDb } from "../db/index.js";
import {
  remoteGrants,
  remoteGrantTargets,
  remoteGrantRules,
  remoteGrantTaskSnapshots,
} from "../db/schema/index.js";
import { eq, and, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type {
  RemoteGrantType,
  RemoteGrantStatus,
  RemoteGrantEligibilityMode,
  RemoteGrantTargetType,
  RemoteRevocationMode,
  ParticipantStanding,
  RemoteActionScope,
} from "@orcy/shared/types";

// ---------------------------------------------------------------------------
// Remote Grants
// ---------------------------------------------------------------------------

export interface CreateRemoteGrantInput {
  habitatId: string;
  remotePodId: string;
  remoteParticipantId?: string | null;
  grantType: RemoteGrantType;
  standing: ParticipantStanding;
  actionScopes?: RemoteActionScope[];
  eligibilityMode?: RemoteGrantEligibilityMode;
  includeFutureMatches?: boolean;
  graceWindowHours?: number;
  expiresAt?: string | null;
  createdBy?: string | null;
}

export interface RemoteGrantRow {
  id: string;
  habitatId: string;
  remotePodId: string;
  remoteParticipantId: string | null;
  grantType: string;
  standing: string;
  actionScopes: string[];
  eligibilityMode: string;
  includeFutureMatches: boolean;
  graceWindowHours: number;
  status: string;
  expiresAt: string | null;
  expiredAt: string | null;
  revocationMode: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const grantFields = {
  id: remoteGrants.id,
  habitatId: remoteGrants.habitatId,
  remotePodId: remoteGrants.remotePodId,
  remoteParticipantId: remoteGrants.remoteParticipantId,
  grantType: remoteGrants.grantType,
  standing: remoteGrants.standing,
  actionScopes: remoteGrants.actionScopes,
  eligibilityMode: remoteGrants.eligibilityMode,
  includeFutureMatches: remoteGrants.includeFutureMatches,
  graceWindowHours: remoteGrants.graceWindowHours,
  status: remoteGrants.status,
  expiresAt: remoteGrants.expiresAt,
  expiredAt: remoteGrants.expiredAt,
  revocationMode: remoteGrants.revocationMode,
  revokedAt: remoteGrants.revokedAt,
  revokedBy: remoteGrants.revokedBy,
  revokeReason: remoteGrants.revokeReason,
  createdBy: remoteGrants.createdBy,
  createdAt: remoteGrants.createdAt,
  updatedAt: remoteGrants.updatedAt,
} as const;

export function createRemoteGrant(input: CreateRemoteGrantInput): RemoteGrantRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(remoteGrants)
      .values({
        id,
        habitatId: input.habitatId,
        remotePodId: input.remotePodId,
        remoteParticipantId: input.remoteParticipantId ?? null,
        grantType: input.grantType,
        standing: input.standing,
        actionScopes: input.actionScopes ?? [],
        eligibilityMode: input.eligibilityMode ?? "allowlist",
        includeFutureMatches: input.includeFutureMatches ?? false,
        graceWindowHours: input.graceWindowHours ?? 24,
        status: "active",
        expiresAt: input.expiresAt ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remoteGrant", err as Error, id);
  }

  const row = getRemoteGrantById(id);
  if (!row) throw repositoryNotFoundError("remoteGrant", id);
  return row;
}

export function getRemoteGrantById(id: string): RemoteGrantRow | null {
  const db = getDb();
  const rows = db.select(grantFields).from(remoteGrants).where(eq(remoteGrants.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getActiveGrantsByHabitat(habitatId: string): RemoteGrantRow[] {
  const db = getDb();
  return db
    .select(grantFields)
    .from(remoteGrants)
    .where(and(eq(remoteGrants.habitatId, habitatId), eq(remoteGrants.status, "active")))
    .all();
}

export function getActiveGrantsByParticipant(remoteParticipantId: string): RemoteGrantRow[] {
  const db = getDb();
  return db
    .select(grantFields)
    .from(remoteGrants)
    .where(
      and(
        eq(remoteGrants.remoteParticipantId, remoteParticipantId),
        eq(remoteGrants.status, "active"),
      ),
    )
    .all();
}

export function getActiveGrantsByPod(remotePodId: string): RemoteGrantRow[] {
  const db = getDb();
  return db
    .select(grantFields)
    .from(remoteGrants)
    .where(and(eq(remoteGrants.remotePodId, remotePodId), eq(remoteGrants.status, "active")))
    .all();
}

export function getGrantsByHabitat(
  habitatId: string,
  status?: RemoteGrantStatus,
): RemoteGrantRow[] {
  const db = getDb();
  const condition = status
    ? and(eq(remoteGrants.habitatId, habitatId), eq(remoteGrants.status, status))
    : eq(remoteGrants.habitatId, habitatId);
  return db.select(grantFields).from(remoteGrants).where(condition).all();
}

export function updateRemoteGrantStatus(
  id: string,
  status: RemoteGrantStatus,
  extra?: {
    expiredAt?: string;
    revocationMode?: RemoteRevocationMode;
    revokedAt?: string;
    revokedBy?: string;
    revokeReason?: string;
  },
): RemoteGrantRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteGrants)
      .set({ status, ...extra, updatedAt: now })
      .where(eq(remoteGrants.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteGrant", err as Error, id);
  }
  return getRemoteGrantById(id);
}

export function revokeRemoteGrant(
  id: string,
  mode: RemoteRevocationMode,
  revokedBy: string,
  revokeReason?: string,
): RemoteGrantRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const statusMap: Record<RemoteRevocationMode, RemoteGrantStatus> = {
    soft: "soft_revoked",
    hard: "hard_revoked",
    freeze: "frozen",
  };
  try {
    db.update(remoteGrants)
      .set({
        status: statusMap[mode],
        revocationMode: mode,
        revokedAt: now,
        revokedBy,
        revokeReason: revokeReason ?? null,
        updatedAt: now,
      })
      .where(eq(remoteGrants.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteGrant", err as Error, id);
  }
  return getRemoteGrantById(id);
}

export function expireActiveGrants(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const toExpire = db
    .select({ id: remoteGrants.id })
    .from(remoteGrants)
    .where(and(eq(remoteGrants.status, "active"), lt(remoteGrants.expiresAt, now)))
    .all();
  for (const row of toExpire) {
    db.update(remoteGrants)
      .set({ status: "expired", expiredAt: now, updatedAt: now })
      .where(eq(remoteGrants.id, row.id))
      .run();
  }
  return toExpire.length;
}

// ---------------------------------------------------------------------------
// Remote Grant Targets
// ---------------------------------------------------------------------------

export interface RemoteGrantTargetRow {
  id: string;
  grantId: string;
  targetType: string;
  targetId: string;
  createdAt: string;
}

const targetFields = {
  id: remoteGrantTargets.id,
  grantId: remoteGrantTargets.grantId,
  targetType: remoteGrantTargets.targetType,
  targetId: remoteGrantTargets.targetId,
  createdAt: remoteGrantTargets.createdAt,
} as const;

export function addRemoteGrantTarget(
  grantId: string,
  targetType: RemoteGrantTargetType,
  targetId: string,
): RemoteGrantTargetRow {
  const db = getDb();
  const id = uuid();
  try {
    db.insert(remoteGrantTargets).values({ id, grantId, targetType, targetId }).run();
  } catch (err) {
    throw repositoryCreateError("remoteGrantTarget", err as Error, id);
  }
  return db
    .select(targetFields)
    .from(remoteGrantTargets)
    .where(eq(remoteGrantTargets.id, id))
    .all()[0];
}

export function getRemoteGrantTargets(grantId: string): RemoteGrantTargetRow[] {
  const db = getDb();
  return db
    .select(targetFields)
    .from(remoteGrantTargets)
    .where(eq(remoteGrantTargets.grantId, grantId))
    .all();
}

export function removeRemoteGrantTarget(grantId: string, targetId: string): void {
  const db = getDb();
  db.delete(remoteGrantTargets)
    .where(and(eq(remoteGrantTargets.grantId, grantId), eq(remoteGrantTargets.targetId, targetId)))
    .run();
}

// ---------------------------------------------------------------------------
// Remote Grant Rules
// ---------------------------------------------------------------------------

export interface RemoteGrantRuleRow {
  id: string;
  grantId: string;
  domains: string[];
  labels: string[];
  capabilities: string[];
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

const ruleFields = {
  id: remoteGrantRules.id,
  grantId: remoteGrantRules.grantId,
  domains: remoteGrantRules.domains,
  labels: remoteGrantRules.labels,
  capabilities: remoteGrantRules.capabilities,
  timeWindowStart: remoteGrantRules.timeWindowStart,
  timeWindowEnd: remoteGrantRules.timeWindowEnd,
  createdAt: remoteGrantRules.createdAt,
  updatedAt: remoteGrantRules.updatedAt,
} as const;

export function setRemoteGrantRule(
  grantId: string,
  rule: {
    domains?: string[];
    labels?: string[];
    capabilities?: string[];
    timeWindowStart?: string | null;
    timeWindowEnd?: string | null;
  },
): RemoteGrantRuleRow {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .select(ruleFields)
    .from(remoteGrantRules)
    .where(eq(remoteGrantRules.grantId, grantId))
    .all();

  if (existing.length > 0) {
    try {
      db.update(remoteGrantRules)
        .set({ ...rule, updatedAt: now })
        .where(eq(remoteGrantRules.grantId, grantId))
        .run();
    } catch (err) {
      throw repositoryUpdateError("remoteGrantRule", err as Error, grantId);
    }
    return db
      .select(ruleFields)
      .from(remoteGrantRules)
      .where(eq(remoteGrantRules.grantId, grantId))
      .all()[0];
  }

  const id = uuid();
  try {
    db.insert(remoteGrantRules)
      .values({
        id,
        grantId,
        domains: rule.domains ?? [],
        labels: rule.labels ?? [],
        capabilities: rule.capabilities ?? [],
        timeWindowStart: rule.timeWindowStart ?? null,
        timeWindowEnd: rule.timeWindowEnd ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remoteGrantRule", err as Error, id);
  }
  return db
    .select(ruleFields)
    .from(remoteGrantRules)
    .where(eq(remoteGrantRules.grantId, grantId))
    .all()[0];
}

export function getRemoteGrantRule(grantId: string): RemoteGrantRuleRow | null {
  const db = getDb();
  const rows = db
    .select(ruleFields)
    .from(remoteGrantRules)
    .where(eq(remoteGrantRules.grantId, grantId))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// Remote Grant Task Snapshots
// ---------------------------------------------------------------------------

export interface RemoteGrantTaskSnapshotRow {
  id: string;
  grantId: string;
  taskId: string;
  matchedAt: string;
  matchReason: string;
  createdAt: string;
}

const snapshotFields = {
  id: remoteGrantTaskSnapshots.id,
  grantId: remoteGrantTaskSnapshots.grantId,
  taskId: remoteGrantTaskSnapshots.taskId,
  matchedAt: remoteGrantTaskSnapshots.matchedAt,
  matchReason: remoteGrantTaskSnapshots.matchReason,
  createdAt: remoteGrantTaskSnapshots.createdAt,
} as const;

export function addGrantTaskSnapshot(
  grantId: string,
  taskId: string,
  matchReason?: string,
): RemoteGrantTaskSnapshotRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  try {
    db.insert(remoteGrantTaskSnapshots)
      .values({
        id,
        grantId,
        taskId,
        matchedAt: now,
        matchReason: matchReason ?? "",
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("grantTaskSnapshot", err as Error, id);
  }
  return db
    .select(snapshotFields)
    .from(remoteGrantTaskSnapshots)
    .where(eq(remoteGrantTaskSnapshots.id, id))
    .all()[0];
}

export function getGrantTaskSnapshots(grantId: string): RemoteGrantTaskSnapshotRow[] {
  const db = getDb();
  return db
    .select(snapshotFields)
    .from(remoteGrantTaskSnapshots)
    .where(eq(remoteGrantTaskSnapshots.grantId, grantId))
    .all();
}

export function isTaskInGrantSnapshot(grantId: string, taskId: string): boolean {
  const db = getDb();
  const rows = db
    .select({ id: remoteGrantTaskSnapshots.id })
    .from(remoteGrantTaskSnapshots)
    .where(
      and(
        eq(remoteGrantTaskSnapshots.grantId, grantId),
        eq(remoteGrantTaskSnapshots.taskId, taskId),
      ),
    )
    .all();
  return rows.length > 0;
}
