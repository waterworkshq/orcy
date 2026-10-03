import { getDb } from "../db/index.js";
import { codeEvidenceLinks } from "../db/schema/index.js";
import { eq, and, sql, ne, desc, asc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type {
  CodeEvidenceType,
  CodeEvidenceLinkSource,
  CodeEvidenceVerificationState,
  CodeEvidenceTargetType,
  CodeEvidenceActorType,
} from "@orcy/shared";
import {
  repositoryCreateError,
  repositoryUpdateError,
  repositoryTransactionError,
} from "../errors/repository.js";

/** Client accepted by the supplied-client link primitives (top-level db or a transaction). */
export type LinkDbClient = ReturnType<typeof getDb>;

function validateConfidence(confidence: number | null | undefined): void {
  if (confidence == null) return;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Code evidence confidence must be between 0 and 1");
  }
}

const DEFAULT_TARGET_LIST_LIMIT = 100;

export function getById(id: string) {
  const db = getDb();
  const rows = db.select().from(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getByIdWithClient(client: LinkDbClient, id: string) {
  const rows = client.select().from(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getActiveByTarget(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  options?: { limit?: number },
) {
  const db = getDb();
  const limit = options?.limit ?? DEFAULT_TARGET_LIST_LIMIT;
  return (
    db
      .select()
      .from(codeEvidenceLinks)
      .where(
        and(
          eq(codeEvidenceLinks.targetType, targetType),
          eq(codeEvidenceLinks.targetId, targetId),
          eq(codeEvidenceLinks.status, "active"),
        ),
      )
      // Deterministic capped order: newest linkedAt first, ascending row id on ties.
      .orderBy(desc(codeEvidenceLinks.linkedAt), asc(codeEvidenceLinks.id))
      .limit(limit)
      .all()
  );
}

export function getAllByTarget(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  options?: { limit?: number },
) {
  const db = getDb();
  const limit = options?.limit ?? DEFAULT_TARGET_LIST_LIMIT;
  return db
    .select()
    .from(codeEvidenceLinks)
    .where(
      and(eq(codeEvidenceLinks.targetType, targetType), eq(codeEvidenceLinks.targetId, targetId)),
    )
    .limit(limit)
    .all();
}

export function getHistoryByTarget(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  options?: { limit?: number },
) {
  const db = getDb();
  const limit = options?.limit ?? DEFAULT_TARGET_LIST_LIMIT;
  return (
    db
      .select()
      .from(codeEvidenceLinks)
      .where(
        and(
          eq(codeEvidenceLinks.targetType, targetType),
          eq(codeEvidenceLinks.targetId, targetId),
          ne(codeEvidenceLinks.status, "active"),
        ),
      )
      // Deterministic capped order: most recent correction timestamp first,
      // falling back to linkedAt when a history row was never corrected.
      .orderBy(
        desc(sql`coalesce(${codeEvidenceLinks.correctedAt}, ${codeEvidenceLinks.linkedAt})`),
        asc(codeEvidenceLinks.id),
      )
      .limit(limit)
      .all()
  );
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

export function findOrCreateActive(input: {
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
  verificationState?: CodeEvidenceVerificationState;
  confidence?: number | null;
  allowExternalRepository?: boolean;
  metadata?: Record<string, unknown>;
}): { link: typeof codeEvidenceLinks.$inferSelect; created: boolean } | null {
  validateConfidence(input.confidence);
  const db = getDb();
  const normalizedExternalUrl =
    input.normalizedExternalUrl ?? (input.externalUrl ? input.externalUrl.trim() : null);

  try {
    const result = db.transaction((tx) => {
      const conditions = [
        eq(codeEvidenceLinks.targetType, input.targetType),
        eq(codeEvidenceLinks.targetId, input.targetId),
        eq(codeEvidenceLinks.evidenceType, input.evidenceType),
        eq(codeEvidenceLinks.status, "active"),
      ];
      if (input.evidenceId) {
        conditions.push(eq(codeEvidenceLinks.evidenceId, input.evidenceId));
      } else if (normalizedExternalUrl) {
        conditions.push(eq(codeEvidenceLinks.normalizedExternalUrl, normalizedExternalUrl));
      }

      const existing = tx
        .select()
        .from(codeEvidenceLinks)
        .where(and(...conditions))
        .all();
      if (existing.length > 0) {
        return { link: existing[0], created: false };
      }

      const id = uuid();
      const now = new Date().toISOString();
      tx.insert(codeEvidenceLinks)
        .values({
          id,
          targetType: input.targetType,
          targetId: input.targetId,
          evidenceType: input.evidenceType,
          evidenceId: input.evidenceId ?? null,
          externalUrl: input.externalUrl ?? null,
          normalizedExternalUrl,
          title: input.title ?? null,
          description: input.description ?? null,
          linkSource: input.linkSource,
          linkSources: input.linkSources ?? [input.linkSource],
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
          allowExternalRepository: Boolean(input.allowExternalRepository),
          metadata: input.metadata ?? {},
        })
        .run();

      const created = tx.select().from(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, id)).all();
      return created.length > 0 ? { link: created[0], created: true } : null;
    });

    return result;
  } catch (err) {
    throw repositoryTransactionError(
      "codeEvidenceLink",
      err as Error,
      `${input.targetType}:${input.targetId}`,
    );
  }
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
  validateConfidence(input.confidence);
  const db = getDb();
  const id = uuid();
  const now = input.linkedAt ?? new Date().toISOString();

  try {
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
        allowExternalRepository: Boolean(input.allowExternalRepository),
        metadata: input.metadata ?? {},
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("codeEvidenceLink", err as Error, id);
  }

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
  try {
    db.update(codeEvidenceLinks)
      .set({
        linkSources: existingSources,
      })
      .where(eq(codeEvidenceLinks.id, linkId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("codeEvidenceLink", err as Error, linkId);
  }

  return getById(linkId);
}

/**
 * Marks a source link corrected or superseded. The update is fenced on the
 * link's polymorphic target pair as well as its id, so a link that moved to
 * another target (or another target type) after the caller's pre-read is not
 * mutated by this call. The returned row is the one the UPDATE actually
 * changed, or null when the id/target pair matched nothing.
 */
export function correctLink(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  id: string,
  status: "incorrect" | "removed" | "superseded",
  correctedByType: CodeEvidenceActorType,
  correctedById: string,
  correctionReason: string,
  replacementLinkId?: string | null,
) {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    const matched = db
      .update(codeEvidenceLinks)
      .set({
        status,
        correctedByType,
        correctedById,
        correctedAt: now,
        correctionReason,
        replacementLinkId: replacementLinkId ?? null,
      })
      .where(
        and(
          eq(codeEvidenceLinks.id, id),
          eq(codeEvidenceLinks.targetType, targetType),
          eq(codeEvidenceLinks.targetId, targetId),
        ),
      )
      .returning()
      .all();
    return matched.length > 0 ? matched[0] : null;
  } catch (err) {
    throw repositoryUpdateError("codeEvidenceLink", err as Error, id);
  }
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
        eq(codeEvidenceLinks.allowExternalRepository, true),
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
        ne(codeEvidenceLinks.status, "active"),
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

// ---------------------------------------------------------------------------
// Supplied-client primitives for the opted-in local report write bundle.
//
// These run FLAT on the caller's client (top-level db or the report bundle's
// transaction) — they never open a transaction of their own, so composing them
// inside one synchronous immediate bundle cannot nest root transactions. The
// generic wrappers above keep their signatures and semantics for excluded
// callers (webhook/backfill/mirror/remote ensure-link paths).
// ---------------------------------------------------------------------------

/**
 * Finds or creates an active evidence link on the supplied client without
 * opening a nested transaction. Inside the report bundle the immediate
 * transaction serializes the select-then-insert against other writers; the
 * generic `findOrCreateActive` (own root transaction) stays untouched for
 * out-of-scope callers.
 */
export function findOrCreateActiveWithClient(
  client: LinkDbClient,
  input: {
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
    verificationState?: CodeEvidenceVerificationState;
    confidence?: number | null;
    allowExternalRepository?: boolean;
    metadata?: Record<string, unknown>;
  },
): { link: typeof codeEvidenceLinks.$inferSelect; created: boolean } | null {
  validateConfidence(input.confidence);
  const normalizedExternalUrl =
    input.normalizedExternalUrl ?? (input.externalUrl ? input.externalUrl.trim() : null);

  const conditions = [
    eq(codeEvidenceLinks.targetType, input.targetType),
    eq(codeEvidenceLinks.targetId, input.targetId),
    eq(codeEvidenceLinks.evidenceType, input.evidenceType),
    eq(codeEvidenceLinks.status, "active"),
  ];
  // Same dedupe key as the generic findOrCreateActive wrapper: the
  // normalized URL column, never the raw URL text.
  if (input.evidenceId) {
    conditions.push(eq(codeEvidenceLinks.evidenceId, input.evidenceId));
  } else if (normalizedExternalUrl) {
    conditions.push(eq(codeEvidenceLinks.normalizedExternalUrl, normalizedExternalUrl));
  }

  const existing = client
    .select()
    .from(codeEvidenceLinks)
    .where(and(...conditions))
    .all();
  if (existing.length > 0) {
    return { link: existing[0], created: false };
  }

  const id = uuid();
  const now = new Date().toISOString();
  client
    .insert(codeEvidenceLinks)
    .values({
      id,
      targetType: input.targetType,
      targetId: input.targetId,
      evidenceType: input.evidenceType,
      evidenceId: input.evidenceId ?? null,
      externalUrl: input.externalUrl ?? null,
      normalizedExternalUrl,
      title: input.title ?? null,
      description: input.description ?? null,
      linkSource: input.linkSource,
      linkSources: input.linkSources ?? [input.linkSource],
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
      allowExternalRepository: Boolean(input.allowExternalRepository),
      metadata: input.metadata ?? {},
    })
    .run();

  const created = client.select().from(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, id)).all();
  return created.length > 0 ? { link: created[0], created: true } : null;
}

/**
 * Appends a corroborating source on the supplied client. Unlike the generic
 * wrapper there is no read-modify-write through `getById`: the row is read
 * and re-read on the same client so the operation participates fully in the
 * caller's transaction.
 */
export function addCorroboratingSourceWithClient(
  client: LinkDbClient,
  linkId: string,
  source: CodeEvidenceLinkSource,
) {
  const link = getByIdWithClient(client, linkId);
  if (!link) return null;

  const existingSources: string[] = Array.isArray(link.linkSources)
    ? (link.linkSources as string[])
    : [];
  if (!existingSources.includes(source)) {
    existingSources.push(source);
  }

  try {
    client
      .update(codeEvidenceLinks)
      .set({
        linkSources: existingSources,
      })
      .where(eq(codeEvidenceLinks.id, linkId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("codeEvidenceLink", err as Error, linkId);
  }

  return getByIdWithClient(client, linkId);
}
