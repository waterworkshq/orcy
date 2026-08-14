/**
 * Triage Publication Occurrences — the first-writer-frozen canonical
 * occurrence store (restored Finding Triage lifecycle).
 *
 * One row per canonical candidate identity (`tpo-v1:<sha256>`). The
 * `insertOrReadWithClient` primitive implements the insert-or-read winner
 * protocol: `INSERT ... ON CONFLICT (snapshot_digest) DO NOTHING`, then a
 * deterministic winner/loser classification via the stored `winner_nonce`
 * (portable across sql.js and better-sqlite3 — `run()` result `changes` is
 * NOT consulted because sql.js returns `true`, not a changes count). A
 * conflict loser receives the WINNING row and must discard every locally
 * rendered/prepared value.
 */
import { getDb } from "../db/index.js";
import { triagePublicationOccurrences } from "../db/schema/index.js";
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { repositoryCreateError } from "../errors/repository.js";

/** Supplied-client type: same DrizzleDB but injected for transaction participation. */
type SuppliedClient = ReturnType<typeof getDb>;

/** A full occurrence row, as selected by drizzle. */
export type TriagePublicationOccurrenceRow = typeof triagePublicationOccurrences.$inferSelect;

/** Input for {@link insertOrReadWithClient}. */
export interface InsertOccurrenceInput {
  id: string;
  habitatId: string;
  clusterKey: string;
  occurrenceVersion: number;
  candidateSnapshot: string;
  snapshotDigest: string;
  renderedPayload: string;
  preparedAggregate: string;
  preparedDigest: string;
  templateId: string;
  templateDigest: string;
}

/** Closed insert-or-read result. */
export type InsertOrReadResult =
  | { winner: true; row: TriagePublicationOccurrenceRow }
  | { winner: false; row: TriagePublicationOccurrenceRow };

/**
 * The insert-or-read winner protocol on the supplied client (the caller owns
 * the immediate transaction). `true` means THIS call inserted the row (its
 * locally rendered payload + prepared aggregate are the frozen authority);
 * `false` means a concurrent first writer won — the returned row is the
 * winner's and every local value must be discarded.
 */
export function insertOrReadWithClient(
  client: SuppliedClient,
  input: InsertOccurrenceInput,
): InsertOrReadResult {
  const winnerNonce = uuid();
  try {
    client
      .insert(triagePublicationOccurrences)
      .values({ ...input, winnerNonce })
      .onConflictDoNothing({ target: triagePublicationOccurrences.snapshotDigest })
      .run();
  } catch (err) {
    throw repositoryCreateError("triagePublicationOccurrences", err as Error, input.id);
  }

  const row = client
    .select()
    .from(triagePublicationOccurrences)
    .where(eq(triagePublicationOccurrences.snapshotDigest, input.snapshotDigest))
    .get();
  if (!row) {
    // Unreachable: either this call inserted it or the UNIQUE digest means a
    // row with this digest exists. Surface as an anomaly rather than guessing.
    throw repositoryCreateError(
      "triagePublicationOccurrences",
      new Error("insert-or-read re-read found no row (data anomaly)"),
      input.id,
    );
  }

  // Winner classification is nonce-based, NOT changes-based: sql.js `run()`
  // returns `true` (no changes count), so the portable discriminator is
  // whether the stored nonce is the one THIS call generated.
  return { winner: row.winnerNonce === winnerNonce, row };
}

/** Reads an occurrence by its canonical id. */
export function getById(
  id: string,
): TriagePublicationOccurrenceRow | null {
  const row = getDb()
    .select()
    .from(triagePublicationOccurrences)
    .where(eq(triagePublicationOccurrences.id, id))
    .get();
  return row ?? null;
}

/** Reads an occurrence by its canonical id on the supplied client. */
export function getByIdWithClient(
  client: SuppliedClient,
  id: string,
): TriagePublicationOccurrenceRow | null {
  const row = client
    .select()
    .from(triagePublicationOccurrences)
    .where(eq(triagePublicationOccurrences.id, id))
    .get();
  return row ?? null;
}

/** Lists every occurrence frozen for a habitat+cluster (newest first). */
export function listByCluster(
  habitatId: string,
  clusterKey: string,
): TriagePublicationOccurrenceRow[] {
  return getDb()
    .select()
    .from(triagePublicationOccurrences)
    .where(
      and(
        eq(triagePublicationOccurrences.habitatId, habitatId),
        eq(triagePublicationOccurrences.clusterKey, clusterKey),
      ),
    )
    .all();
}
