import { getDb } from "../db/index.js";
import { externalIntakeCandidates } from "../db/schema/index.js";
import { eq, and, desc } from "drizzle-orm";
import type {
  ExternalIntakeCandidate,
  ExternalIntakeReviewStatus,
  IntegrationProvider,
} from "@orcy/shared";
import { v4 as uuid } from "uuid";
import { repositoryUpdateError } from "../errors/repository.js";

export function create(input: {
  connectionId: string;
  habitatId: string;
  provider: IntegrationProvider;
  externalId: string;
  externalKey: string;
  externalUrl: string;
  sourceKind?: string | null;
  sourceStatus?: string | null;
  sourcePriority?: string | null;
  sourceAssignees?: string[];
  sourceReporter?: string | null;
  sourceLabels?: string[];
  sourceTitle: string;
  sourceBody?: string | null;
  rawProviderPayload?: Record<string, unknown> | null;
  externalUpdatedAt?: string | null;
}): ExternalIntakeCandidate {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(externalIntakeCandidates)
    .values({
      id,
      connectionId: input.connectionId,
      habitatId: input.habitatId,
      provider: input.provider,
      externalId: input.externalId,
      externalKey: input.externalKey,
      externalUrl: input.externalUrl,
      sourceKind: input.sourceKind ?? null,
      sourceStatus: input.sourceStatus ?? null,
      sourcePriority: input.sourcePriority ?? null,
      sourceAssignees: input.sourceAssignees ?? [],
      sourceReporter: input.sourceReporter ?? null,
      sourceLabels: input.sourceLabels ?? [],
      sourceTitle: input.sourceTitle,
      sourceBody: input.sourceBody ?? null,
      normalizedSummary: null,
      recommendedMissionTitle: null,
      recommendedMissionDescription: null,
      reviewStatus: "new",
      promotedMissionId: null,
      rawProviderPayload: input.rawProviderPayload ?? null,
      externalUpdatedAt: input.externalUpdatedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const result = getById(id);
  if (!result) throw new Error("Failed to create intake candidate");
  return result;
}

export function getById(id: string): ExternalIntakeCandidate | null {
  const db = getDb();
  return db
    .select()
    .from(externalIntakeCandidates)
    .where(eq(externalIntakeCandidates.id, id))
    .get() as ExternalIntakeCandidate | null;
}

export function findByConnectionAndExternalId(
  connectionId: string,
  externalId: string,
): ExternalIntakeCandidate | null {
  const db = getDb();
  return db
    .select()
    .from(externalIntakeCandidates)
    .where(
      and(
        eq(externalIntakeCandidates.connectionId, connectionId),
        eq(externalIntakeCandidates.externalId, externalId),
      ),
    )
    .get() as ExternalIntakeCandidate | null;
}

export function listByHabitat(
  habitatId: string,
  filters?: { reviewStatus?: ExternalIntakeReviewStatus; provider?: IntegrationProvider },
): ExternalIntakeCandidate[] {
  const db = getDb();
  const conditions = [eq(externalIntakeCandidates.habitatId, habitatId)];

  if (filters?.reviewStatus) {
    conditions.push(eq(externalIntakeCandidates.reviewStatus, filters.reviewStatus));
  }
  if (filters?.provider) {
    conditions.push(eq(externalIntakeCandidates.provider, filters.provider));
  }

  return db
    .select()
    .from(externalIntakeCandidates)
    .where(and(...conditions))
    .orderBy(desc(externalIntakeCandidates.updatedAt))
    .all() as ExternalIntakeCandidate[];
}

export function update(
  id: string,
  input: {
    sourceTitle?: string;
    sourceBody?: string | null;
    sourceStatus?: string | null;
    sourcePriority?: string | null;
    sourceLabels?: string[];
    sourceAssignees?: string[];
    reviewStatus?: ExternalIntakeReviewStatus;
    promotedMissionId?: string | null;
    normalizedSummary?: string | null;
    recommendedMissionTitle?: string | null;
    recommendedMissionDescription?: string | null;
    externalUpdatedAt?: string | null;
    rawProviderPayload?: Record<string, unknown> | null;
  },
): ExternalIntakeCandidate | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = getById(id);
  if (!existing) return null;

  const values: Partial<typeof externalIntakeCandidates.$inferInsert> = { updatedAt: now };
  if (input.sourceTitle !== undefined) values.sourceTitle = input.sourceTitle;
  if (input.sourceBody !== undefined) values.sourceBody = input.sourceBody;
  if (input.sourceStatus !== undefined) values.sourceStatus = input.sourceStatus;
  if (input.sourcePriority !== undefined) values.sourcePriority = input.sourcePriority;
  if (input.sourceLabels !== undefined) values.sourceLabels = input.sourceLabels;
  if (input.sourceAssignees !== undefined) values.sourceAssignees = input.sourceAssignees;
  if (input.reviewStatus !== undefined) values.reviewStatus = input.reviewStatus;
  if (input.promotedMissionId !== undefined) values.promotedMissionId = input.promotedMissionId;
  if (input.normalizedSummary !== undefined) values.normalizedSummary = input.normalizedSummary;
  if (input.recommendedMissionTitle !== undefined)
    values.recommendedMissionTitle = input.recommendedMissionTitle;
  if (input.recommendedMissionDescription !== undefined)
    values.recommendedMissionDescription = input.recommendedMissionDescription;
  if (input.externalUpdatedAt !== undefined) values.externalUpdatedAt = input.externalUpdatedAt;
  if (input.rawProviderPayload !== undefined) values.rawProviderPayload = input.rawProviderPayload;

  try {
    db.update(externalIntakeCandidates)
      .set(values)
      .where(eq(externalIntakeCandidates.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("externalIntakeCandidate", err as Error, id);
  }
  return getById(id);
}
