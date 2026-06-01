import { getDb } from "../db/index.js";
import { codeEvidenceLinks } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type {
  CodeEvidenceType,
  CodeEvidenceLinkSource,
  CodeEvidenceVerificationState,
  CodeEvidenceLinkStatus,
  CodeEvidenceTargetType,
  CodeEvidenceActorType,
} from "@orcy/shared";

export function getById(id: string) {
  const db = getDb();
  const rows = db.select().from(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getActiveByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  return db
    .select()
    .from(codeEvidenceLinks)
    .where(
      and(
        eq(codeEvidenceLinks.targetType, targetType),
        eq(codeEvidenceLinks.targetId, targetId),
        eq(codeEvidenceLinks.status, "active"),
      ),
    )
    .all();
}

export function getAllByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  return db
    .select()
    .from(codeEvidenceLinks)
    .where(
      and(eq(codeEvidenceLinks.targetType, targetType), eq(codeEvidenceLinks.targetId, targetId)),
    )
    .all();
}

export function getHistoryByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  return db
    .select()
    .from(codeEvidenceLinks)
    .where(
      and(
        eq(codeEvidenceLinks.targetType, targetType),
        eq(codeEvidenceLinks.targetId, targetId),
        sql`${codeEvidenceLinks.status} != 'active'`,
      ),
    )
    .all();
}

export function findActiveDuplicate(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  evidenceType: CodeEvidenceType,
  evidenceId: string | null,
  externalUrl?: string | null,
): typeof codeEvidenceLinks.$inferSelect | null {
  const db = getDb();
  const conditions = [
    eq(codeEvidenceLinks.targetType, targetType),
    eq(codeEvidenceLinks.targetId, targetId),
    eq(codeEvidenceLinks.evidenceType, evidenceType),
    eq(codeEvidenceLinks.status, "active"),
  ];

  if (evidenceId) {
    conditions.push(eq(codeEvidenceLinks.evidenceId, evidenceId));
  } else if (externalUrl) {
    conditions.push(eq(codeEvidenceLinks.normalizedExternalUrl, externalUrl));
  }

  const rows = db
    .select()
    .from(codeEvidenceLinks)
    .where(and(...conditions))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function create(input: {
  targetType: CodeEvidenceTargetType;
  targetId: string;
  evidenceType: CodeEvidenceType;
  evidenceId?: string | null;
  externalUrl?: string | null;
  normalizedExternalUrl?: string | null;
  title?: string | null;
  description?: string | null;
  linkSource: CodeEvidenceLinkSource;
  linkSources?: string[];
  linkedByType: CodeEvidenceActorType;
  linkedById: string;
  linkedAt?: string;
  verificationState?: CodeEvidenceVerificationState;
  confidence?: number | null;
  allowExternalRepository?: boolean;
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  const id = uuid();
  const now = input.linkedAt ?? new Date().toISOString();

  db.insert(codeEvidenceLinks)
    .values({
      id,
      targetType: input.targetType,
      targetId: input.targetId,
      evidenceType: input.evidenceType,
      evidenceId: input.evidenceId ?? null,
      externalUrl: input.externalUrl ?? null,
      normalizedExternalUrl: input.normalizedExternalUrl ?? null,
      title: input.title ?? null,
      description: input.description ?? null,
      linkSource: input.linkSource,
      linkSources: input.linkSources ?? [],
      linkedByType: input.linkedByType,
      linkedById: input.linkedById,
      linkedAt: now,
      verificationState: input.verificationState ?? "unverified",
      confidence: input.confidence ?? null,
      status: "active",
      correctedByType: null,
      correctedById: null,
      correctedAt: null,
      correctionReason: null,
      replacementLinkId: null,
      allowExternalRepository: input.allowExternalRepository ? true : false,
      metadata: input.metadata ?? {},
    })
    .run();

  return getById(id);
}

export function addCorroboratingSource(linkId: string, source: CodeEvidenceLinkSource) {
  const link = getById(linkId);
  if (!link) return null;

  const existingSources: string[] = Array.isArray(link.linkSources)
    ? (link.linkSources as string[])
    : [];
  if (!existingSources.includes(source)) {
    existingSources.push(source);
  }

  const db = getDb();
  db.update(codeEvidenceLinks)
    .set({
      linkSources: existingSources,
    })
    .where(eq(codeEvidenceLinks.id, linkId))
    .run();

  return getById(linkId);
}

export function correctLink(
  id: string,
  status: "incorrect" | "removed" | "superseded",
  correctedByType: CodeEvidenceActorType,
  correctedById: string,
  correctionReason: string,
  replacementLinkId?: string | null,
) {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(codeEvidenceLinks)
    .set({
      status,
      correctedByType,
      correctedById,
      correctedAt: now,
      correctionReason,
      replacementLinkId: replacementLinkId ?? null,
    })
    .where(eq(codeEvidenceLinks.id, id))
    .run();

  return getById(id);
}

export function countActiveByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(codeEvidenceLinks)
    .where(
      and(
        eq(codeEvidenceLinks.targetType, targetType),
        eq(codeEvidenceLinks.targetId, targetId),
        eq(codeEvidenceLinks.status, "active"),
      ),
    )
    .get();
  return result?.count ?? 0;
}

export function countByTargetAndType(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  const rows = db
    .select({
      evidenceType: codeEvidenceLinks.evidenceType,
      count: sql<number>`count(*)`,
    })
    .from(codeEvidenceLinks)
    .where(
      and(
        eq(codeEvidenceLinks.targetType, targetType),
        eq(codeEvidenceLinks.targetId, targetId),
        eq(codeEvidenceLinks.status, "active"),
      ),
    )
    .groupBy(codeEvidenceLinks.evidenceType)
    .all();

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.evidenceType] = row.count;
  }
  return result;
}

export function countByTargetAndVerification(targetType: CodeEvidenceTargetType, targetId: string) {
  const db = getDb();
  const rows = db
    .select({
      verificationState: codeEvidenceLinks.verificationState,
      count: sql<number>`count(*)`,
    })
    .from(codeEvidenceLinks)
    .where(
      and(
        eq(codeEvidenceLinks.targetType, targetType),
        eq(codeEvidenceLinks.targetId, targetId),
        eq(codeEvidenceLinks.status, "active"),
      ),
    )
    .groupBy(codeEvidenceLinks.verificationState)
    .all();

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.verificationState] = row.count;
  }
  return result;
}

export function hasExternalRepoEvidence(
  targetType: CodeEvidenceTargetType,
  targetId: string,
): boolean {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(codeEvidenceLinks)
    .where(
      and(
        eq(codeEvidenceLinks.targetType, targetType),
        eq(codeEvidenceLinks.targetId, targetId),
        eq(codeEvidenceLinks.status, "active"),
        sql`${codeEvidenceLinks.allowExternalRepository} = 1`,
      ),
    )
    .get();
  return (result?.count ?? 0) > 0;
}

function countNonActiveByTarget(targetType: CodeEvidenceTargetType, targetId: string): number {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(codeEvidenceLinks)
    .where(
      and(
        eq(codeEvidenceLinks.targetType, targetType),
        eq(codeEvidenceLinks.targetId, targetId),
        sql`${codeEvidenceLinks.status} != 'active'`,
      ),
    )
    .get();
  return result?.count ?? 0;
}

export function countCorrectedByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  return countNonActiveByTarget(targetType, targetId);
}

export function countHistoryByTarget(targetType: CodeEvidenceTargetType, targetId: string) {
  return countNonActiveByTarget(targetType, targetId);
}
