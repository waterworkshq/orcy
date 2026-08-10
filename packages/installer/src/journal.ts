import fs from "node:fs";
import path from "node:path";
import { ORCY_PATHS } from "@orcy/shared";
import {
  readManifest,
  writeManifest,
  mergeEntryFields,
  type Manifest,
  type ManifestEntry,
  type InstallIntent,
} from "./manifest.js";
import { atomicWriteJson } from "./atomic-write.js";

/**
 * In-flight installation transaction journal (design §7 G1, G3; decision D4).
 *
 * TWO-FILE MODEL (G1):
 *   - Journal  (~/.orcy/install-journal.json): transient, in-flight, per-step.
 *     Its PRESENCE on disk is the "install in progress / interrupted" signal.
 *   - Manifest (~/.orcy/install-manifest.json): committed ledger, written once
 *     on all-steps-done via {@link commitJournal}. The manifest path NEVER holds
 *     in-flight state — enforced structurally, since only `writeManifest` touches
 *     it, and only at the commit point.
 *
 * ATOMIC WRITES: every journal write is temp + fsync + rename, mirroring
 *   manifest.ts's `writeManifest` exactly. The temp file lives in the SAME
 *   directory as the target so the POSIX rename is atomic; fsync durably persists
 *   the temp's data before the rename so power loss cannot leave a renamed-but-
 *   empty file.
 *
 * CRASH-MID-COMMIT CONTRACT: {@link commitJournal} does `writeManifest(manifest)`
 *   THEN `unlinkSync(journal)`. If the process dies in that window, BOTH files
 *   exist on the next start. `journalExists() === true` is the stale signal — the
 *   caller (P1.4) treats the journal as stale and deletes it; the manifest is
 *   authoritative. If `writeManifest` throws, the `unlinkSync` is never reached,
 *   so a failed commit leaves the journal intact and is retryable.
 *
 * This module is additive and not yet wired into the install flow (wiring is
 * P1.4); it is exercised only by its own unit tests today.
 */

const JOURNAL_PATH = path.join(ORCY_PATHS.home, "install-journal.json");

const JOURNAL_VERSION = 1;

/**
 * A single in-flight operation. Extends {@link ManifestEntry} so that, on commit,
 * a `done` entry maps 1:1 to a manifest entry with no schema translation beyond
 * stripping the journal-only fields (see {@link toManifestEntry}).
 */
export interface JournalEntry extends ManifestEntry {
  /** Sequence index of this operation (0-based; equals its position in `steps`).
   *  Stable across a journal's lifetime: steps are appended in order and never
   *  reordered or removed. */
  step: number;
  /** Lifecycle status. `pending` = appended but not complete; `done` = completed
   *  (eligible for manifest commit); `failed` = errored. */
  status: "pending" | "done" | "failed";
  /** ISO timestamp of the most recent status/phase transition. */
  ts: string;
  /** Present iff `status === "failed"`: the error that caused the failure. */
  error?: string;
  /**
   * G3 two-phase sub-stepping discriminator. Records the most-reached sub-phase
   * of an operation that needs finer-than-step granularity for stale-journal
   * viability checks. Currently only the `registerAgent` step uses it.
   *
   * registerAgent sub-phase model — the three distinguishable states a stale
   * reader must tell apart (design §7 G3 / G5):
   *   - phase `"post"`        + status `"pending"`: POST /api/agents not yet
   *                           attempted (or in flight — indistinguishable, treated
   *                           as not-done).
   *   - phase `"credentials"` + status `"pending"`: POST SUCCEEDED (agentId
   *                           captured in {@link phasePayload}) but the local
   *                           credentials.json write did not complete. The remote
   *                           side-effect is committed; the local one is not.
   *   - status `"done"`:      POST + credential write both complete.
   *
   * A stale-journal reader thus distinguishes "POST never attempted" from "POST
   * succeeded but local credential write failed" by inspecting `phase` +
   * `phasePayload.agentId` while `status` is still `"pending"`. Wiring of
   * `registerAgent` to these phases is P1.3; this module provides only the shape.
   */
  phase?: string;
  /** Step-specific sub-phase payload. `registerAgent` stores `{ agentId }` here
   *  once the POST returns, so a stale reader knows the remote mutation occurred
   *  even though `status` is still `"pending"`. */
  phasePayload?: Record<string, unknown>;
}

/** The in-flight transaction record. Its file's presence on disk == in-flight. */
export interface Journal {
  version: number;
  /** ISO timestamp the transaction started (becomes the manifest's `installedAt`). */
  startedAt: string;
  /** Components selected for this transaction (deduped; mirrors manifest.components). */
  components: string[];
  /** Ordered in-flight operations. */
  steps: JournalEntry[];
  /** Wizard intent snapshot (typed since P4.1/P7.3; drives update replay). */
  intent?: InstallIntent;
}

export function journalPath(): string {
  return JOURNAL_PATH;
}

export function journalExists(): boolean {
  return fs.existsSync(JOURNAL_PATH);
}

/**
 * Initialize a fresh journal and atomically persist it. Creates `~/.orcy/` if
 * needed (mode 0o600 on the journal file). Returns the in-memory journal.
 *
 * `init` (optional, a refinement over the zero-arg spec) lets the caller seed
 * `components`/`intent` at creation; zero-arg calls are unaffected.
 */
export function createJournal(init?: Partial<Pick<Journal, "components" | "intent">>): Journal {
  const j: Journal = {
    version: JOURNAL_VERSION,
    startedAt: new Date().toISOString(),
    components: init?.components ? [...new Set(init.components)] : [],
    steps: [],
    ...(init?.intent !== undefined && { intent: init.intent }),
  };
  writeJournalAtomic(j);
  return j;
}

/**
 * Parse the journal. Returns `null` if absent or corrupt (mirrors `readManifest`'s
 * catch-to-null). A `null` journal means "no in-flight transaction" — the caller
 * proceeds as a fresh install.
 */
export function readJournal(): Journal | null {
  try {
    return JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/** Input for {@link appendStep}: the manifest-identity fields plus any optional
 *  sub-phase fields. `step`/`status`/`ts` are assigned by the module. */
export type StepInput = Omit<JournalEntry, "step" | "status" | "ts" | "error">;

/**
 * Append a `pending` step and atomically write. Read-modify-write is safe here —
 * a single installer process owns a transaction. Throws if no journal exists
 * ({@link createJournal} must be called first).
 */
export function appendStep(input: StepInput): void {
  const j = requireInFlight();
  j.steps.push({
    ...input,
    step: j.steps.length,
    status: "pending",
    ts: new Date().toISOString(),
  });
  writeJournalAtomic(j);
}

/**
 * Append a `done` step, deduped on `{path, action}` against existing steps of
 * any status — mirroring manifest.ts `record()`'s manifest dedup but applied to
 * the journal's `steps[]`.
 *
 * This is the journal-side redirection target for manifest `record()`: when a
 * journal is in flight, `record(entry)` calls this instead of writing the
 * manifest. The dedup ensures that if an earlier `appendStep` already created
 * a step for the same `{path, action}` (e.g. `registerAgent` in credentials.ts),
 * the redirected `record()` from `writeCredentials` becomes a no-op — the
 * registerAgent reconciliation seam (design §7 G3; P1.3/P1.4).
 *
 * Entries arrive as `done` (not `pending`) because `record()` callers have
 * already completed their filesystem mutation — the record happens post-mutation.
 */
export function recordStep(input: StepInput): void {
  const j = requireInFlight();
  // Upsert (G2H.1): if a step for {path, action} exists, refresh its metadata
  // (hash/keys/backup/marker) instead of dropping the re-record. Mirrors
  // manifest record()'s merge so a refreshed hash survives into the journal.
  const existing = j.steps.find((s) => s.path === input.path && s.action === input.action);
  if (existing) {
    if (mergeEntryFields(existing, input)) writeJournalAtomic(j);
    return;
  }
  j.steps.push({
    ...input,
    step: j.steps.length,
    status: "done",
    ts: new Date().toISOString(),
  });
  writeJournalAtomic(j);
}

/**
 * Advance a step's G3 sub-phase WITHOUT changing its status (the operation is
 * still `pending`). Used to record intermediate progress such as the
 * `registerAgent` `"post" → "credentials"` transition. `payload` carries
 * step-specific data (e.g. `{ agentId }`). Throws if no journal or step exists.
 */
export function setStepPhase(step: number, phase: string, payload?: Record<string, unknown>): void {
  const j = requireInFlight();
  const e = j.steps.find((s) => s.step === step);
  if (!e) throw new Error(`setStepPhase: step ${step} not found in journal`);
  e.phase = phase;
  if (payload !== undefined) e.phasePayload = payload;
  e.ts = new Date().toISOString();
  writeJournalAtomic(j);
}

/** Mark a step `done` and atomically write. Throws if no journal or step exists. */
export function markStepDone(step: number): void {
  const j = requireInFlight();
  const e = j.steps.find((s) => s.step === step);
  if (!e) throw new Error(`markStepDone: step ${step} not found in journal`);
  e.status = "done";
  e.ts = new Date().toISOString();
  delete e.error;
  writeJournalAtomic(j);
}

/** Mark a step `failed` with an error message and atomically write. */
export function markStepFailed(step: number, error: string): void {
  const j = requireInFlight();
  const e = j.steps.find((s) => s.step === step);
  if (!e) throw new Error(`markStepFailed: step ${step} not found in journal`);
  e.status = "failed";
  e.error = error;
  e.ts = new Date().toISOString();
  writeJournalAtomic(j);
}

/** Dedup-into `components[]` and atomically write (mirrors manifest.addComponent). */
export function addJournalComponent(name: string): void {
  const j = requireInFlight();
  if (!j.components.includes(name)) {
    j.components.push(name);
    writeJournalAtomic(j);
  }
}

/**
 * THE COMMIT POINT. Build a {@link Manifest} from the journal's `done` entries,
 * merge with any existing committed manifest (so entries from a prior install
 * that are not re-recorded in this transaction — e.g. credentials when the agent
 * is already registered — survive the commit), atomically write it to the
 * manifest path (via `writeManifest`, already atomic per P1.1), then unlink the
 * journal.
 *
 * Idempotent: if no journal exists but a manifest does (already committed), the
 * existing manifest is returned unchanged. If neither exists, returns `null`.
 *
 * Crash safety: `writeManifest` completes (manifest durable) BEFORE the journal is
 * unlinked. A crash in that window leaves both files — `journalExists()` then
 * signals stale and the caller deletes the journal (manifest authoritative).
 */
export function commitJournal(): Manifest | null {
  const j = readJournal();
  if (!j) return readManifest();
  // Merge with the existing committed manifest: a re-install may skip some
  // steps (e.g. agent already registered → no credentials record). Those prior
  // entries must survive — the manifest is the full ledger, not just this run.
  const existing = readManifest();
  const priorFiles = existing?.files ?? [];
  const priorComponents = existing?.components ?? [];
  const journalFiles = j.steps.filter((s) => s.status === "done").map(toManifestEntry);
  // Dedup on {path, action} with metadata upsert (G2H.1): a journal entry that
  // duplicates a prior manifest entry refreshes its metadata (hash/keys/etc.)
  // rather than being dropped, so a refreshed hash commits correctly.
  const mergedFiles = [...priorFiles];
  for (const f of journalFiles) {
    const existing = mergedFiles.find((m) => m.path === f.path && m.action === f.action);
    if (existing) {
      mergeEntryFields(existing, f);
    } else {
      mergedFiles.push(f);
    }
  }
  const mergedComponents = [...priorComponents];
  for (const c of j.components) {
    if (!mergedComponents.includes(c)) mergedComponents.push(c);
  }
  const manifest: Manifest = {
    version: 1,
    installedAt: existing?.installedAt ?? j.startedAt,
    components: mergedComponents,
    files: mergedFiles,
    ...(j.intent !== undefined ? { intent: j.intent } : {}),
  };
  writeManifest(manifest);
  fs.unlinkSync(JOURNAL_PATH);
  return manifest;
}

/** Abort: unlink the journal without committing. Used for cleanup / explicit abort. */
export function discardJournal(): void {
  try {
    fs.unlinkSync(JOURNAL_PATH);
  } catch {
    /* absent journal — nothing to discard */
  }
}

// --- internals ----------------------------------------------------------------

function requireInFlight(): Journal {
  const j = readJournal();
  if (!j) {
    throw new Error("journal operation called before createJournal — no in-flight transaction");
  }
  return j;
}

/** Strip the journal-only fields, returning the {@link ManifestEntry} subset. */
export function toManifestEntry(e: JournalEntry): ManifestEntry {
  const out: ManifestEntry = { path: e.path, action: e.action };
  if (e.marker !== undefined) out.marker = e.marker;
  if (e.keys !== undefined) out.keys = e.keys;
  if (e.backup !== undefined) out.backup = e.backup;
  if (e.hash !== undefined) out.hash = e.hash;
  return out;
}

/**
 * Atomically write the journal via the shared {@link atomicWriteJson} helper
 * (temp + fsync + rename + temp cleanup on failure). The temp file is in the
 * SAME directory as the target so the rename is atomic on POSIX.
 */
function writeJournalAtomic(j: Journal): void {
  atomicWriteJson(JOURNAL_PATH, JSON.stringify(j, null, 2), 0o600);
}
