import * as pulseRepo from "../repositories/pulse.js";
import * as missionRepo from "../repositories/mission.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import * as taskService from "./tasks/index.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { logger } from "../lib/logger.js";
import { badRequest, notFound, forbidden } from "../errors.js";
import { findingMetadataSchema, SIGNAL_TYPES, type SignalType } from "@orcy/shared";
import { getDb } from "../db/index.js";
import { isCreationPublicationEnabled } from "../config/creationPublicationCutover.js";
import { publishBlockerClearanceTask } from "./taskBlockerPublication.js";

export { type SignalType };
/** Alias of {@link SIGNAL_TYPES} from @orcy/shared, retained for backward compatibility with existing importers. */
export const VALID_SIGNAL_TYPES = SIGNAL_TYPES;

const MAX_METADATA_BYTES = 10_000;

type PulseCreatedHook = (pulse: pulseRepo.Pulse) => void;
const pulseCreatedHooks: PulseCreatedHook[] = [];

/**
 * Registers a hook invoked after every pulse creation and returns an unsubscribe function, mutating the internal hooks list for the process lifetime.
 */
export function onPulseCreated(hook: PulseCreatedHook): () => void {
  pulseCreatedHooks.push(hook);
  return () => {
    const idx = pulseCreatedHooks.indexOf(hook);
    if (idx >= 0) pulseCreatedHooks.splice(idx, 1);
  };
}

/**
 * Persists a {@link pulseRepo.Pulse} and synchronously runs all registered `onPulseCreated` hooks, swallowing per-hook errors so one bad subscriber cannot block the others.
 */
/**
 * Creates a pulse and fires all registered `onPulseCreated` hooks (skill ingestion, detector
 * dispatch). Does NOT broadcast via SSE — callers MUST separately call `broadcastPulse(pulse)`
 * if they want the `pulse.signal_posted` SSE event emitted (for UI invalidation).
 *
 * This split is intentional: some callers (e.g. `emitAutoSignal` bookkeeping) don't want SSE.
 * Most callers SHOULD pair this with `broadcastPulse`:
 *
 * ```ts
 * const pulse = createPulseAndNotify(input);
 * broadcastPulse(pulse);
 * ```
 *
 * Failing to call `broadcastPulse` results in a pulse that's in the DB and ingested by skill
 * hooks, but invisible to the SSE-driven UI (stale queries until next refetch).
 */

export function createPulseAndNotify(input: pulseRepo.CreatePulseInput): pulseRepo.Pulse {
  const pulse = pulseRepo.createPulse(input);
  for (const hook of pulseCreatedHooks) {
    try {
      hook(pulse);
    } catch (err) {
      logger.error({ err }, "Pulse created hook failed");
    }
  }
  return pulse;
}

/**
 * Atomic batch insert for pulses (ADR-0039 § Atomic Post-Interceptor Signal
 * Batch / Q11).
 *
 * Opens ONE database transaction and inserts every input via the tx-aware
 * {@link pulseRepo.createPulseWithClient}. If any single insert throws, the
 * transaction rolls back and zero pulses are committed — restoring
 * ADR-0014's all-or-nothing returned-signal promise that the previous
 * sequential `for (signal) { await createDetectedSignal(signal) }` loop could
 * not guarantee (a mid-batch failure left a partial write).
 *
 * Hooks (`onPulseCreated`) and SSE (`broadcastPulse`) are published ONLY after
 * the transaction commits — no externally visible signal side effect may occur
 * before commit. A post-commit hook or SSE failure is logged and swallowed so
 * one bad subscriber cannot poison the batch; the committed pulses are still
 * returned.
 *
 * Returns the committed pulses in input order. An empty input array is a
 * no-op and returns `[]` without opening a transaction.
 */
export function createPulseBatchAtomic(inputs: pulseRepo.CreatePulseInput[]): pulseRepo.Pulse[] {
  if (inputs.length === 0) return [];

  const db = getDb();
  const committed: pulseRepo.Pulse[] = [];
  db.transaction((tx) => {
    for (const input of inputs) {
      committed.push(pulseRepo.createPulseWithClient(tx, input));
    }
  });

  // Post-commit side effects ONLY. The transaction has already committed, so
  // partial-failure here cannot un-commit a pulse. Each subscriber/SSE call is
  // isolated so one failure does not skip subsequent pulses.
  for (const pulse of committed) {
    for (const hook of pulseCreatedHooks) {
      try {
        hook(pulse);
      } catch (err) {
        logger.error({ err, pulseId: pulse.id }, "Pulse created hook failed (batch)");
      }
    }
    broadcastPulse(pulse);
  }
  return committed;
}

/**
 * Inserts a system-authored `isAuto` pulse for the given mission, silently no-oping and logging on a missing mission or persistence failure.
 */
export function emitAutoSignal(opts: {
  missionId: string;
  signalType: string;
  subject: string;
  taskId?: string;
  body?: string;
}): void {
  try {
    const mission = missionRepo.getMissionById(opts.missionId);
    if (!mission) return;

    pulseRepo.createPulse({
      missionId: opts.missionId,
      habitatId: mission.habitatId,
      fromType: "system",
      fromId: "system",
      signalType: opts.signalType as pulseRepo.SignalType,
      subject: opts.subject,
      body: opts.body ?? "",
      taskId: opts.taskId,
      isAuto: true,
    });
  } catch (err) {
    logger.error(
      { err, missionId: opts.missionId, signalType: opts.signalType },
      "Failed to emit auto-signal",
    );
  }
}

/** Request body accepted by {@link postMissionPulseSignal} and {@link postHabitatPulseSignal} when authoring a new pulse. */
export interface PulsePostInput {
  signalType: string;
  subject: string;
  body?: string;
  taskId?: string;
  toAgentId?: string;
  toAgentName?: string;
  replyToId?: string;
  metadata?: Record<string, unknown>;
}

/** Identity of the actor posting a pulse, determining the `fromType`/`fromId` recorded on the persisted row. */
export interface PulsePostCaller {
  type: "human" | "agent" | "remote_human" | "remote_orcy";
  id: string;
}

/** Outcome of posting a pulse: the persisted row, any auto-created blocker clearance task, and whether one was created. */
export interface PulsePostResult {
  pulse: pulseRepo.Pulse;
  linkedTask?: Task;
  blockerTaskCreated: boolean;
}

type Task = NonNullable<ReturnType<typeof taskRepo.getTaskById>>;

function resolveAgentName(name: string): string | null {
  const agent = agentRepo.getAgentByName(name);
  return agent?.id ?? null;
}

function checkReplyScope(replyToId: string | undefined, habitatId: string, scope: string): void {
  if (!replyToId) return;
  const parent = pulseRepo.getPulseById(replyToId);
  if (!parent) throw notFound("Reply target pulse not found");
  if (parent.habitatId !== habitatId) throw forbidden("Cannot reply across habitats");
  if (parent.scope !== scope) throw forbidden("Cannot reply across scopes");
}

function formatFindingMetadataError(error: { errors: Array<{ message: string }> }): string {
  return error.errors.map((issue) => issue.message).join("; ");
}

function validateMetadata(signalType: string, metadata: Record<string, unknown> | undefined): void {
  if (metadata && JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
    throw badRequest(`Metadata exceeds maximum size (${MAX_METADATA_BYTES / 1000}KB)`);
  }

  if (signalType === "finding") {
    const result = findingMetadataSchema.safeParse(metadata ?? {});
    if (!result.success) {
      throw badRequest(`Invalid finding metadata: ${formatFindingMetadataError(result.error)}`);
    }
  }
}

function resolveRecipient(body: PulsePostInput): { toType?: "human" | "agent"; toId?: string } {
  if (body.toAgentId) {
    return { toType: "agent", toId: body.toAgentId };
  }
  if (body.toAgentName) {
    const resolved = resolveAgentName(body.toAgentName);
    if (!resolved) throw notFound(`Agent not found: ${body.toAgentName}`);
    return { toType: "agent", toId: resolved };
  }
  return {};
}

export function broadcastPulse(pulse: pulseRepo.Pulse): void {
  try {
    sseBroadcaster.publish(pulse.habitatId, {
      type: "pulse.signal_posted",
      data: {
        pulseId: pulse.id,
        missionId: pulse.missionId,
        signalType: pulse.signalType,
        fromType: pulse.fromType,
        fromId: pulse.fromId,
        subject: pulse.subject,
      },
    });
  } catch (err) {
    logger.warn({ err }, "SSE broadcast failed after pulse creation");
  }
}

function createBlockerClearanceTask(opts: {
  pulse: pulseRepo.Pulse;
  parentId: string;
  isHabitatScope: boolean;
  blockedTaskId?: string;
}): Task | null {
  // T11 Phase 1E — flag-gated blocker-clearance routing. When the cutover flag
  // is ON (tests / T11), route through `publishBlockerClearanceTask` (kernel
  // chain: reserve → prepare → govern → publish + the C1 habitat-scope boundary
  // rejection — the gap-audit O2 / cold-critique C1 fix). When OFF (production
  // default), the legacy `taskService.createTask` path runs byte-identical.
  // Mirrors the precedent at `automationExecutor.ts:273-275` +
  // `scheduledTaskService.ts:152-154` + `triageService.ts:38-40/112-114`.
  if (isCreationPublicationEnabled()) {
    try {
      const result = publishBlockerClearanceTask({
        pulseId: opts.pulse.id,
        habitatId: opts.pulse.habitatId,
        scope: opts.isHabitatScope
          ? { kind: "habitat" }
          : { kind: "mission", missionId: opts.parentId },
        pulseSubject: opts.pulse.subject,
        pulseBody: opts.pulse.body,
        blockedTaskId: opts.blockedTaskId,
        assignment: { kind: "auto" },
      });

      // Map the typed result envelope to the legacy `Task | null` contract.
      // `created` (committed, possibly still recovering) → the published Task
      // row; preserve the denormalized `pulse.linkedTaskId` field the legacy
      // path stamped so UI observers see the same linkage.
      if (result.outcome === "created") {
        const task = result.publication.task;
        pulseRepo.updateLinkedTask(opts.pulse.id, task.id);
        return task as Task;
      }
      // `replayed` — a prior publication under the same key already succeeded.
      // The stored terminal carries `taskId` (the originally-created Task).
      // Re-read via the repo so the caller sees the durable Task row rather
      // than a swallowed null (mirrors the triage MINOR #3 fix).
      if (result.outcome === "replayed" && result.terminal.taskId) {
        return taskRepo.getTaskById(result.terminal.taskId) ?? null;
      }
      // `rejected_no_target_mission` — the C1 habitat-scope boundary. The
      // adapter refuses to create a Task under an invalid `missionId`; the
      // signal remains as a visible pulse (the replacement path is an
      // Automation Rule or manual creation under an explicit Mission).
      if (result.outcome === "rejected_no_target_mission") {
        logger.warn(
          { pulseId: opts.pulse.id, habitatId: opts.pulse.habitatId },
          "Blocker clearance publication rejected: habitat-scoped pulse has no target Mission",
        );
        return null;
      }
      // Any other outcome (vetoed, rejected_validation, guard_mismatch,
      // governance_denied, rejected_fingerprint) is a non-terminal or
      // terminal failure. Match the legacy catch→null swallow + a logged
      // warning so the scan caller sees `blockerTaskCreated: false`.
      logger.warn(
        { pulseId: opts.pulse.id, outcome: result.outcome },
        "Blocker clearance publication non-terminal outcome",
      );
      return null;
    } catch (err) {
      logger.error(
        { err, parentId: opts.parentId, pulseId: opts.pulse.id },
        "Failed to create blocker clearance task",
      );
      return null;
    }
  }

  try {
    const descriptionLines = [
      opts.isHabitatScope
        ? "Auto-generated habitat blocker clearance task."
        : "Auto-generated blocker clearance task.",
      "",
      `Blocker: ${opts.pulse.body ?? ""}`,
      "",
      `Source signal: ${opts.pulse.id}`,
    ];
    if (opts.blockedTaskId) {
      descriptionLines.push(`Blocked task: ${opts.blockedTaskId}`);
    }

    const task = taskService.createTask({
      missionId: opts.parentId,
      title: `Clear Blocker: ${opts.pulse.subject}`,
      description: descriptionLines.join("\n"),
      priority: "high",
      labels: ["blocker-clearance"],
      createdBy: "system",
    });

    pulseRepo.updateLinkedTask(opts.pulse.id, task.id);
    return taskRepo.getTaskById(task.id) ?? null;
  } catch (err) {
    logger.error(
      { err, parentId: opts.parentId, pulseId: opts.pulse.id },
      "Failed to create blocker clearance task",
    );
    return null;
  }
}

function validatePostBody(body: PulsePostInput): void {
  if (!body.signalType || !body.subject) {
    throw badRequest("Missing required fields: signalType, subject");
  }
  if (!VALID_SIGNAL_TYPES.includes(body.signalType as SignalType)) {
    throw badRequest(`Invalid signalType. Must be one of: ${VALID_SIGNAL_TYPES.join(", ")}`);
  }
  // The "detected" category is reachable only from the plugin detector capability surface
  // (PulseWriter.createDetectedSignal) — agents/humans posting via REST/MCP cannot forge it
  // (ADR-0013). The detector path bypasses this validator entirely (it calls
  // createPulseAndNotify directly), so reaching this branch with "detected" indicates an
  // attempted provenance forgery.
  if (body.signalType === "detected") {
    throw badRequest("signalType 'detected' is reachable only from plugin detector capability");
  }
}

/**
 * Validates and posts a mission-scoped {@link pulseRepo.Pulse}, auto-creating a linked blocker clearance task on `blocker` signals for non-archived missions, and broadcasts the result over SSE.
 */
export function postMissionPulseSignal(input: {
  missionId: string;
  caller: PulsePostCaller;
  body: PulsePostInput;
}): PulsePostResult {
  validatePostBody(input.body);
  const { caller, body } = input;

  const mission = missionRepo.getMissionById(input.missionId);
  if (!mission) {
    throw notFound("Mission not found");
  }

  const { toType, toId } = resolveRecipient(body);
  checkReplyScope(body.replyToId, mission.habitatId, "mission");
  validateMetadata(body.signalType, body.metadata);

  const pulse = createPulseAndNotify({
    missionId: input.missionId,
    habitatId: mission.habitatId,
    fromType: caller.type,
    fromId: caller.id,
    toType,
    toId,
    signalType: body.signalType as pulseRepo.SignalType,
    subject: body.subject,
    body: body.body ?? "",
    taskId: body.taskId ?? undefined,
    replyToId: body.replyToId ?? undefined,
    metadata: body.metadata ?? undefined,
  });

  let linkedTask: Task | null = null;
  if (body.signalType === "blocker" && !mission.isArchived) {
    linkedTask = createBlockerClearanceTask({
      pulse,
      parentId: input.missionId,
      isHabitatScope: false,
      blockedTaskId: body.taskId,
    });
  }

  broadcastPulse(pulse);

  return {
    pulse,
    linkedTask: linkedTask ?? undefined,
    blockerTaskCreated: !!linkedTask,
  };
}

/**
 * Validates and posts a habitat-scoped {@link pulseRepo.Pulse}, auto-creating a linked blocker clearance task on `blocker` signals, and broadcasts the result over SSE.
 */
export function postHabitatPulseSignal(input: {
  habitatId: string;
  caller: PulsePostCaller;
  body: PulsePostInput;
}): PulsePostResult {
  validatePostBody(input.body);
  const { caller, body } = input;

  const habitat = habitatRepo.getHabitatById(input.habitatId);
  if (!habitat) {
    throw notFound("Habitat not found");
  }

  const { toType, toId } = resolveRecipient(body);
  checkReplyScope(body.replyToId, input.habitatId, "habitat");
  validateMetadata(body.signalType, body.metadata);

  const pulse = createPulseAndNotify({
    habitatId: input.habitatId,
    scope: "habitat",
    fromType: caller.type,
    fromId: caller.id,
    toType,
    toId,
    signalType: body.signalType as pulseRepo.SignalType,
    subject: body.subject,
    body: body.body ?? "",
    taskId: body.taskId ?? undefined,
    replyToId: body.replyToId ?? undefined,
    metadata: body.metadata ?? undefined,
  });

  let linkedTask: Task | null = null;
  if (body.signalType === "blocker") {
    linkedTask = createBlockerClearanceTask({
      pulse,
      parentId: input.habitatId,
      isHabitatScope: true,
    });
  }

  broadcastPulse(pulse);

  return {
    pulse,
    linkedTask: linkedTask ?? undefined,
    blockerTaskCreated: !!linkedTask,
  };
}
