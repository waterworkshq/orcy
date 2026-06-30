import { getDb } from "../db/index.js";
import { pulses } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { repositoryUpdateError } from "../errors/repository.js";
import type { SuggestedBucket } from "@orcy/shared";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";

/** Attribution actor shared across triage write paths. */
export type TriageActor = {
  type: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  id: string;
};

/** Minimal pulse projection accepted by {@link enterTriage}. */
export interface EnterTriagePulseInput {
  id: string;
  habitatId: string;
  subject: string;
  metadata: { findingKind?: string } & Record<string, unknown>;
}

/**
 * Enter a finding pulse into triage (ADR-0027). Creates a {@link findingTriage}
 * record (dedup-aware) and, only when this pulse becomes the record's source,
 * writes the one-time `findingTriageId` pointer back into the pulse metadata
 * (bidirectional linkage contract — DESIGN.md). Corroborating appends do not
 * mutate the original pulse.
 */
export function enterTriage(pulse: EnterTriagePulseInput): { findingTriageId: string } {
  const record = findingTriageRepo.createForPulse(pulse);
  // The record's source pulse equals the input only on fresh creation; on a
  // corroborating append the source pulseId is the original, not this one.
  if (record.pulseId === pulse.id) {
    writeFindingTriageIdPointer(pulse.id, record.id);
  }
  return { findingTriageId: record.id };
}

/**
 * Confirm a routing bucket and transition `open → triaged`. The bucket captures
 * the human's routing decision (fix_now / defer_to_* / document / investigate).
 */
export function confirmBucket(id: string, bucket: SuggestedBucket, actor: TriageActor): void {
  findingTriageRepo.setBucket(id, bucket);
  findingTriageRepo.transitionStatus(id, "triaged", actor);
}

/**
 * Resolve a finding: transition to `resolved` and write a {@link triageResolutions}
 * row keyed by clusterKey for proactive matching on future recurrences.
 */
export function resolve(id: string, note: string, actor: TriageActor): void {
  findingTriageRepo.transitionStatus(id, "resolved", actor);
  const record = findingTriageRepo.getById(id);
  if (!record) return;

  triageResolutionsRepo.create({
    habitatId: record.habitatId,
    clusterKey: record.clusterKey,
    skillCategory: "convention",
    source: "finding_triage",
    sourceId: id,
    resolution: note,
    resolvedByType: actor.type,
    resolvedById: actor.id,
  });
}

/**
 * Promote a triaged finding into active work (`triaged → in_progress`). Corrective
 * task/mission creation is delegated to the caller (Phase 5 routes) which has the
 * habitat's template context; this service owns the lifecycle transition only.
 */
export function promote(id: string, _actor: TriageActor): { missionId?: string } {
  findingTriageRepo.promote(id);
  return {};
}

/**
 * Write-once pointer from a finding pulse to its `finding_triage` record
 * (ADR-0027 bidirectional linkage). No-op if the pulse is gone or already
 * carries a pointer — the live status is never denormalized onto the pulse.
 */
function writeFindingTriageIdPointer(pulseId: string, findingTriageId: string): void {
  const db = getDb();
  const row = db.select().from(pulses).where(eq(pulses.id, pulseId)).get();
  if (!row) return;

  const metadata =
    (row.metadata as Record<string, unknown> | null) ?? ({} as Record<string, unknown>);
  if (metadata.findingTriageId !== undefined) return;

  metadata.findingTriageId = findingTriageId;
  try {
    db.update(pulses).set({ metadata }).where(eq(pulses.id, pulseId)).run();
  } catch (err) {
    throw repositoryUpdateError("pulse", err as Error, pulseId);
  }
}
