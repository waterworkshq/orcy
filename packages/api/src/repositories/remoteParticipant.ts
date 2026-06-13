import { getDb } from "../db/index.js";
import { remoteParticipants } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type {
  RemoteParticipantType,
  RemoteParticipantStatus,
  ParticipantStanding,
} from "@orcy/shared/types";

export interface CreateRemoteParticipantInput {
  remotePodId: string;
  habitatId: string;
  participantType: RemoteParticipantType;
  displayName: string;
  standing?: ParticipantStanding;
  proposedCapabilities?: string[];
  proposedDomains?: string[];
  externalIdentityId?: string | null;
  registeredBy?: string | null;
}

export interface RemoteParticipantRow {
  id: string;
  remotePodId: string;
  habitatId: string;
  participantType: string;
  displayName: string;
  standing: string;
  proposedCapabilities: string[];
  proposedDomains: string[];
  approvedCapabilities: string[];
  approvedDomains: string[];
  status: string;
  externalIdentityId: string | null;
  registeredBy: string | null;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  revokedAt: string | null;
}

const fields = {
  id: remoteParticipants.id,
  remotePodId: remoteParticipants.remotePodId,
  habitatId: remoteParticipants.habitatId,
  participantType: remoteParticipants.participantType,
  displayName: remoteParticipants.displayName,
  standing: remoteParticipants.standing,
  proposedCapabilities: remoteParticipants.proposedCapabilities,
  proposedDomains: remoteParticipants.proposedDomains,
  approvedCapabilities: remoteParticipants.approvedCapabilities,
  approvedDomains: remoteParticipants.approvedDomains,
  status: remoteParticipants.status,
  externalIdentityId: remoteParticipants.externalIdentityId,
  registeredBy: remoteParticipants.registeredBy,
  createdAt: remoteParticipants.createdAt,
  updatedAt: remoteParticipants.updatedAt,
  suspendedAt: remoteParticipants.suspendedAt,
  revokedAt: remoteParticipants.revokedAt,
} as const;

export function createRemoteParticipant(input: CreateRemoteParticipantInput): RemoteParticipantRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(remoteParticipants)
      .values({
        id,
        remotePodId: input.remotePodId,
        habitatId: input.habitatId,
        participantType: input.participantType,
        displayName: input.displayName,
        standing: input.standing ?? "remote_observer",
        proposedCapabilities: input.proposedCapabilities ?? [],
        proposedDomains: input.proposedDomains ?? [],
        approvedCapabilities: [],
        approvedDomains: [],
        status: "pending",
        externalIdentityId: input.externalIdentityId ?? null,
        registeredBy: input.registeredBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remoteParticipant", err as Error, id);
  }

  const row = getRemoteParticipantById(id);
  if (!row) throw repositoryNotFoundError("remoteParticipant", id);
  return row;
}

export function getRemoteParticipantById(id: string): RemoteParticipantRow | null {
  const db = getDb();
  const rows = db
    .select(fields)
    .from(remoteParticipants)
    .where(eq(remoteParticipants.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getRemoteParticipantsByPod(
  remotePodId: string,
  status?: RemoteParticipantStatus,
): RemoteParticipantRow[] {
  const db = getDb();
  const condition = status
    ? and(eq(remoteParticipants.remotePodId, remotePodId), eq(remoteParticipants.status, status))
    : eq(remoteParticipants.remotePodId, remotePodId);
  return db.select(fields).from(remoteParticipants).where(condition).all();
}

export function getRemoteParticipantsByHabitat(
  habitatId: string,
  status?: RemoteParticipantStatus,
): RemoteParticipantRow[] {
  const db = getDb();
  const condition = status
    ? and(eq(remoteParticipants.habitatId, habitatId), eq(remoteParticipants.status, status))
    : eq(remoteParticipants.habitatId, habitatId);
  return db.select(fields).from(remoteParticipants).where(condition).all();
}

export function activateRemoteParticipant(id: string): RemoteParticipantRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteParticipants)
      .set({ status: "active", updatedAt: now })
      .where(eq(remoteParticipants.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteParticipant", err as Error, id);
  }
  return getRemoteParticipantById(id);
}

export function suspendRemoteParticipant(id: string): RemoteParticipantRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteParticipants)
      .set({ status: "suspended", suspendedAt: now, updatedAt: now })
      .where(eq(remoteParticipants.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteParticipant", err as Error, id);
  }
  return getRemoteParticipantById(id);
}

export function revokeRemoteParticipant(id: string): RemoteParticipantRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteParticipants)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(remoteParticipants.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteParticipant", err as Error, id);
  }
  return getRemoteParticipantById(id);
}

export function updateHostApprovedCapabilities(
  id: string,
  approvedCapabilities: string[],
  approvedDomains: string[],
): RemoteParticipantRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteParticipants)
      .set({ approvedCapabilities, approvedDomains, updatedAt: now })
      .where(eq(remoteParticipants.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteParticipant", err as Error, id);
  }
  return getRemoteParticipantById(id);
}

export function updateRemoteParticipantStanding(
  id: string,
  standing: ParticipantStanding,
): RemoteParticipantRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteParticipants)
      .set({ standing, updatedAt: now })
      .where(eq(remoteParticipants.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteParticipant", err as Error, id);
  }
  return getRemoteParticipantById(id);
}
