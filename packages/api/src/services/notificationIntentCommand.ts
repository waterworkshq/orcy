import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { eq, and, asc, inArray, sql } from "drizzle-orm";
import {
  habitats,
  missions,
  tasks,
  taskEvents,
  taskReviewers,
  teamMembers,
  users,
} from "../db/schema/index.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as podRepo from "../repositories/remotePod.js";
import { isEffectivelyActive } from "./remoteGrantTime.js";
import { isTargetVisibleToParticipant } from "./sharedGrantVisibilityService.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";
import { validateEventType } from "./notificationSubscriptionResolver.js";
import { findRemoteRecipientsForEvent } from "./remoteNotificationResolver.js";
import { renderNotification, type TemplateContext } from "./notificationTemplateService.js";
import { getUserById, getAdmins } from "../repositories/user.js";
import { getAgentById } from "../repositories/agent.js";
import { humanCanAccessHabitat } from "../repositories/teamMember.js";
import type {
  NotificationEvent,
  NotificationDelivery,
  NotificationEventType,
  NotificationSeverity,
  NotificationActorType,
  NotificationSourceType,
  NotificationTargetType,
  NotificationRecipientType,
  NotificationChannel,
  NotificationCadence,
} from "@orcy/shared";

/** Closed audience-intent catalog (N1–N3). Adding a member is a deliberate code change. */
export type NotificationAudienceIntent =
  | { kind: "exact"; recipients: Array<{ recipientType: "human" | "agent"; recipientId: string }> }
  | { kind: "habitat_members" }
  | { kind: "habitat_operators" }
  | { kind: "task_assignee"; taskId: string }
  | { kind: "task_reviewers"; taskId: string }
  | { kind: "task_creator"; taskId: string }
  | {
      kind: "remote_visible";
      targetType: "task" | "mission" | "habitat";
      targetId: string;
      explicitRemote?: Array<{ recipientType: "remote_human" | "remote_orcy"; recipientId: string }>;
    };

export type IntentErrorCode =
  | "UNSUPPORTED_RECIPIENT_FORM"
  | "UNSUPPORTED_CHANNEL_OVERRIDE"
  | "INVALID_EXACT_RECIPIENT"
  | "UNRESOLVED_PROVENANCE"
  | "ASSIGNMENT_INTEGRITY"
  | "MISSING_CONTEXT_TARGET"
  | "UNSUPPORTED_OUTER_SCOPE"
  | "OUTER_SCOPE_NOT_ACTIVE";

export class NotificationIntentError extends Error {
  constructor(readonly code: IntentErrorCode, message: string) {
    super(`${code}:${message}`);
    this.name = "NotificationIntentError";
  }
}

type Candidate = { recipientType: NotificationRecipientType; recipientId: string };

export interface AudienceResolution {
  candidates: Candidate[];
  /** Named remote identities that failed effective-target eligibility (classified, not thrown). */
  suppressedRemote: Candidate[];
  /** Legitimate-empty classification when candidates is empty. */
  emptyReason?: "no_recipients" | "system_creator" | "all_remote_suppressed";
}

/* ------------------------------------------------------------------ */
/* Habitat / task scoping (all reads inside the caller's tx scope)     */
/* ------------------------------------------------------------------ */

function habitatRow(habitatId: string): { id: string; teamId: string | null; ownerUserId: string | null } | null {
  return (
    getDb()
      .select({ id: habitats.id, teamId: habitats.teamId, ownerUserId: habitats.ownerUserId })
      .from(habitats)
      .where(eq(habitats.id, habitatId))
      .get() ?? null
  );
}

/** N6/task-scope: a task belongs to the command's habitat via its mission; no cross-habitat task reads. */
function requireTaskInHabitat(taskId: string, habitatId: string): void {
  const row = getDb()
    .select({ habitatId: missions.habitatId })
    .from(tasks)
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(eq(tasks.id, taskId))
    .get();
  if (!row || row.habitatId !== habitatId) {
    throw new NotificationIntentError("MISSING_CONTEXT_TARGET", `task ${taskId} is not in habitat ${habitatId}`);
  }
}

/* ------------------------------------------------------------------ */
/* Exact-identity validation (N1) — exact intent and typed task rows   */
/* only; population intents NEVER re-apply this filter (fallback admins*/
/* are legitimately non-member recipients).                            */
/* ------------------------------------------------------------------ */

function validateLocalRecipient(habitatId: string, r: Candidate): void {
  if (r.recipientType === "agent") {
    if (!getAgentById(r.recipientId)) {
      throw new NotificationIntentError("INVALID_EXACT_RECIPIENT", `unknown agent ${r.recipientId}`);
    }
    return;
  }
  if (r.recipientType === "human") {
    if (!getUserById(r.recipientId) || !humanCanAccessHabitat(habitatId, r.recipientId)) {
      throw new NotificationIntentError(
        "INVALID_EXACT_RECIPIENT",
        `human ${r.recipientId} is not an admitted recipient of habitat ${habitatId}`,
      );
    }
    return;
  }
  throw new NotificationIntentError(
    "INVALID_EXACT_RECIPIENT",
    `remote identity ${r.recipientId} is not valid in exact intent; use remote_visible`,
  );
}

/* ------------------------------------------------------------------ */
/* Habitat populations (N2)                                            */
/* ------------------------------------------------------------------ */

function resolveHabitatMembers(habitatId: string): Candidate[] {
  const h = habitatRow(habitatId);
  if (!h) throw new NotificationIntentError("MISSING_CONTEXT_TARGET", `habitat ${habitatId} not found`);
  if (h.teamId) {
    const rows = getDb()
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(habitats, eq(habitats.teamId, teamMembers.teamId))
      .where(eq(habitats.id, habitatId))
      .all();
    return rows.map((r) => ({ recipientType: "human" as const, recipientId: r.userId }));
  }
  return h.ownerUserId ? [{ recipientType: "human", recipientId: h.ownerUserId }] : [];
}

function resolveHabitatOperators(habitatId: string): Candidate[] {
  const h = habitatRow(habitatId);
  if (!h) throw new NotificationIntentError("MISSING_CONTEXT_TARGET", `habitat ${habitatId} not found`);
  let scoped: Candidate[] = [];
  if (h.teamId) {
    const rows = getDb()
      .select({ userId: teamMembers.userId, userRole: users.role })
      .from(teamMembers)
      .innerJoin(habitats, eq(habitats.teamId, teamMembers.teamId))
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(habitats.id, habitatId), inArray(teamMembers.role, ["owner", "admin"])))
      .all();
    scoped = rows
      .filter((r) => r.userRole !== "viewer")
      .map((r) => ({ recipientType: "human" as const, recipientId: r.userId }));
  } else if (h.ownerUserId) {
    const owner = getUserById(h.ownerUserId);
    if (owner && owner.role !== "viewer") {
      scoped = [{ recipientType: "human", recipientId: h.ownerUserId }];
    }
  }
  // Fallback only when otherwise unserved (N2). Population eligibility is
  // already derived by this predicate — global admins do NOT pass through
  // exact-membership validation (a non-member global admin is legitimate).
  if (scoped.length > 0) return scoped;
  return getAdmins().map((a) => ({ recipientType: "human" as const, recipientId: a.id }));
}

/* ------------------------------------------------------------------ */
/* Named eligibility uses the same grant-time/visibility primitives   */
/* as discovery, but checks the NAMED active participant's own grants. */
/* Linked identity equality is deduplication, never authority transfer.*/
/* ------------------------------------------------------------------ */

function remoteParticipantTypeOf(p: { participantType: string }): "remote_human" | "remote_orcy" {
  return p.participantType === "remote_human" ? "remote_human" : "remote_orcy";
}

function remoteIdentityEligible(input: {
  habitatId: string;
  eventType: NotificationEventType;
  targetType: "task" | "mission" | "habitat";
  targetId: string;
  participantId: string;
  /** The type the CALLER named for this identity. Must match the persisted
   * participant record's actual participantType — a mismatch is never
   * admitted (typed identity, not an id-string guess). */
  expectedType: "remote_human" | "remote_orcy";
}): boolean {
  const named = participantRepo.getRemoteParticipantById(input.participantId);
  // Source authority: the persisted record decides the identity's type; a
  // caller-named type that contradicts it is not eligible (classified
  // suppressed by the caller, never silently retyped).
  if (!named || named.status !== "active" || remoteParticipantTypeOf(named) !== input.expectedType) return false;
  const now = Date.now();
  const pod = podRepo.getRemotePodById(named.remotePodId);
  if (!pod) return false;
  const grants = grantRepo.getActiveGrantsByHabitat(input.habitatId)
    .filter((grant) => isEffectivelyActive(grant, now))
    .filter((grant) => grant.remotePodId === named.remotePodId &&
      (grant.remoteParticipantId === named.id || grant.remoteParticipantId === null));
  if (grants.length === 0) return false;
  const context: RemoteParticipantContext = {
    participant: named,
    pod,
    credentialId: "",
    habitatId: input.habitatId,
    grants,
  };
  return grants.some((grant) => isTargetVisibleToParticipant(
    context, input.targetType, input.targetId, { grants: [grant], now },
  ).visible);
}

/* ------------------------------------------------------------------ */
/* Audience resolution (N1–N3). Throws NotificationIntentError for     */
/* unsupported/unresolved/invalid intent BEFORE any Event write.       */
/* ------------------------------------------------------------------ */

export function resolveAudience(input: {
  habitatId: string;
  eventType: NotificationEventType;
  intents: NotificationAudienceIntent[];
}): AudienceResolution {
  const candidates: Candidate[] = [];
  const suppressedRemote: Candidate[] = [];
  const seen = new Set<string>();
  let systemCreator = false;
  const push = (c: Candidate) => {
    const key = `${c.recipientType}:${c.recipientId}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };

  for (const intent of input.intents) {
    switch (intent.kind) {
      case "exact": {
        for (const r of intent.recipients) validateLocalRecipient(input.habitatId, r);
        intent.recipients.forEach(push);
        break;
      }
      case "habitat_members": {
        resolveHabitatMembers(input.habitatId).forEach(push);
        break;
      }
      case "habitat_operators": {
        resolveHabitatOperators(input.habitatId).forEach(push);
        break;
      }
      case "task_assignee": {
        requireTaskInHabitat(intent.taskId, input.habitatId);
        const t = getDb()
          .select({ assignedAgentId: tasks.assignedAgentId, remoteAssignedParticipantId: tasks.remoteAssignedParticipantId })
          .from(tasks)
          .where(eq(tasks.id, intent.taskId))
          .get();
        if (!t) throw new NotificationIntentError("MISSING_CONTEXT_TARGET", `task ${intent.taskId} not found`);
        if (t.assignedAgentId && t.remoteAssignedParticipantId) {
          throw new NotificationIntentError(
            "ASSIGNMENT_INTEGRITY",
            `task ${intent.taskId} has both local and remote assignment`,
          );
        }
        if (t.assignedAgentId) {
          validateLocalRecipient(input.habitatId, { recipientType: "agent", recipientId: t.assignedAgentId });
          push({ recipientType: "agent", recipientId: t.assignedAgentId });
        } else if (t.remoteAssignedParticipantId) {
          const named = participantRepo.getRemoteParticipantById(t.remoteAssignedParticipantId);
          if (
            named &&
            remoteIdentityEligible({
              habitatId: input.habitatId,
              eventType: input.eventType,
              targetType: "task",
              targetId: intent.taskId,
              participantId: t.remoteAssignedParticipantId,
              expectedType: remoteParticipantTypeOf(named), // record-typed: the task row names no type
            })
          ) {
            push({ recipientType: remoteParticipantTypeOf(named), recipientId: t.remoteAssignedParticipantId });
          } else {
            suppressedRemote.push({
              recipientType: named ? remoteParticipantTypeOf(named) : "remote_human",
              recipientId: t.remoteAssignedParticipantId,
            });
          }
        }
        break;
      }
      case "task_reviewers": {
        // ROSTER MEMBERSHIP: every current row, ANY status — status is each
        // reviewer's review state, not roster standing. Status filtering is
        // an event-type-dependent guess this intent does not make.
        requireTaskInHabitat(intent.taskId, input.habitatId);
        const rows = getDb()
          .select({ reviewerType: taskReviewers.reviewerType, reviewerId: taskReviewers.reviewerId })
          .from(taskReviewers)
          .where(eq(taskReviewers.taskId, intent.taskId))
          .all();
        for (const r of rows) {
          if (r.reviewerType !== "human" && r.reviewerType !== "agent") {
            throw new NotificationIntentError("INVALID_EXACT_RECIPIENT", `unknown reviewer type ${r.reviewerType}`);
          }
          validateLocalRecipient(input.habitatId, { recipientType: r.reviewerType, recipientId: r.reviewerId });
          push({ recipientType: r.reviewerType, recipientId: r.reviewerId });
        }
        break;
      }
      case "task_creator": {
        // Durable provenance = the typed initial lifecycle event
        // (action "created"|"cloned"); ordering by the task_events
        // `timestamp` column (there is no createdAt on this table).
        requireTaskInHabitat(intent.taskId, input.habitatId);
        const initial = getDb()
          .select({ actorType: taskEvents.actorType, actorId: taskEvents.actorId })
          .from(taskEvents)
          .where(and(eq(taskEvents.taskId, intent.taskId), inArray(taskEvents.action, ["created", "cloned"])))
          .orderBy(asc(taskEvents.timestamp))
          .all();
        const unresolved = () =>
          new NotificationIntentError(
            "UNRESOLVED_PROVENANCE",
            `task ${intent.taskId} has no unambiguous initial-actor provenance`,
          );
        if (initial.length === 0) throw unresolved();
        const first = initial[0];
        if (!first.actorId || initial.some((e) => e.actorType !== first.actorType || e.actorId !== first.actorId)) {
          throw unresolved();
        }
        switch (first.actorType) {
          case "human":
            validateLocalRecipient(input.habitatId, { recipientType: "human", recipientId: first.actorId });
            push({ recipientType: "human", recipientId: first.actorId });
            break;
          case "agent":
            validateLocalRecipient(input.habitatId, { recipientType: "agent", recipientId: first.actorId });
            push({ recipientType: "agent", recipientId: first.actorId });
            break;
          case "system":
            systemCreator = true; // classified, never a fabricated inbox
            break;
          case "remote_human":
          case "remote_orcy": {
            // expectedType = the event row's typed actor (durable provenance);
            // a participant record of a different type is not this actor.
            if (
              remoteIdentityEligible({
                habitatId: input.habitatId,
                eventType: input.eventType,
                targetType: "task",
                targetId: intent.taskId,
                participantId: first.actorId,
                expectedType: first.actorType,
              })
            ) {
              push({ recipientType: first.actorType, recipientId: first.actorId });
            } else {
              suppressedRemote.push({ recipientType: first.actorType, recipientId: first.actorId });
            }
            break;
          }
          default:
            throw unresolved(); // remote_pod and anything else
        }
        break;
      }
      case "remote_visible": {
        if (intent.targetType === "task") {
          requireTaskInHabitat(intent.targetId, input.habitatId);
        } else if (intent.targetType === "mission") {
          const m = getDb()
            .select({ habitatId: missions.habitatId })
            .from(missions)
            .where(eq(missions.id, intent.targetId))
            .get();
          if (!m || m.habitatId !== input.habitatId) {
            throw new NotificationIntentError("MISSING_CONTEXT_TARGET", `mission ${intent.targetId} is not in habitat ${input.habitatId}`);
          }
        } else if (intent.targetId !== input.habitatId) {
          throw new NotificationIntentError("MISSING_CONTEXT_TARGET", `habitat target ${intent.targetId} does not match ${input.habitatId}`);
        } else if (!habitatRow(input.habitatId)) {
          throw new NotificationIntentError("MISSING_CONTEXT_TARGET", `habitat ${input.habitatId} not found`);
        }
        // Accepted pool, verbatim — effective grants/participants/visibility
        // authority is the existing discovery helper (ADR-0043 invariant).
        for (const r of findRemoteRecipientsForEvent({
          habitatId: input.habitatId,
          eventType: input.eventType,
          targetType: intent.targetType,
          targetId: intent.targetId,
        })) {
          push({ recipientType: r.recipientType, recipientId: r.recipientId });
        }
        // Explicit acting remote: NOT a blind union — each is kept only if it
        // independently passes the same effective authority; failures are
        // classified suppressed (best-effort producer contract, no throw).
        for (const r of intent.explicitRemote ?? []) {
          if (
            remoteIdentityEligible({
              habitatId: input.habitatId,
              eventType: input.eventType,
              targetType: intent.targetType,
              targetId: intent.targetId,
              participantId: r.recipientId,
              expectedType: r.recipientType, // caller-named type must match the record's
            })
          ) {
            push({ recipientType: r.recipientType, recipientId: r.recipientId });
          } else {
            suppressedRemote.push({ recipientType: r.recipientType, recipientId: r.recipientId });
          }
        }
        break;
      }
    }
  }

  return {
    candidates,
    suppressedRemote,
    emptyReason:
      candidates.length === 0
        ? systemCreator
          ? "system_creator"
          : suppressedRemote.length > 0
            ? "all_remote_suppressed"
            : "no_recipients"
        : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Subscription policy with required precedence (N5). Everything      */
/* except the required-wins rule mirrors resolveForRecipient          */
/* (notificationSubscriptionResolver.ts:113-189) exactly.              */
/* ------------------------------------------------------------------ */

export interface AudiencePolicyEntry {
  recipientType: NotificationRecipientType;
  recipientId: string;
  channels: NotificationChannel[];
  cadence: NotificationCadence;
  required: boolean;
  suppressed: boolean;
  suppressReason?: "muted" | "disabled" | "no_default" | "ineligible_remote";
}

function isMutedNow(muteUntil: string | null): boolean {
  if (!muteUntil) return false;
  return new Date(muteUntil) > new Date();
}

export function resolveAudiencePolicy(input: {
  habitatId: string;
  eventType: NotificationEventType;
  candidates: Candidate[];
}): AudiencePolicyEntry[] {
  const defaults = subscriptionRepo.getHabitatDefaults(input.habitatId, input.eventType);
  const requiredDefault = defaults.find((d) => d.required) ?? null;
  const plainDefault = defaults.length > 0 ? defaults[0] : null;
  const requiredEntry = (c: Candidate): AudiencePolicyEntry => ({
    ...c,
    channels: requiredDefault!.channels as NotificationChannel[],
    cadence: requiredDefault!.cadence as NotificationCadence,
    required: true,
    suppressed: false,
  });

  return input.candidates.map((c) => {
    // N5: a required default's mandatory channels/cadence beat EVERY
    // override state — disabled, muted, empty-channel AND enabled-nonempty.
    // An alternate personal channel selection never drops the mandatory path.
    if (requiredDefault) return requiredEntry(c);

    const overrides = subscriptionRepo.getRecipientOverrides(
      input.habitatId,
      c.recipientType,
      c.recipientId,
      input.eventType,
    );
    const override = overrides.length > 0 ? overrides[0] : null;

    if (override && !override.enabled) {
      return { ...c, channels: [], cadence: "immediate", required: false, suppressed: true, suppressReason: "disabled" };
    }
    if (override) {
      const muted = isMutedNow(override.muteUntil);
      return {
        ...c,
        channels: override.channels as NotificationChannel[],
        cadence: override.cadence as NotificationCadence,
        required: false,
        suppressed: muted,
        suppressReason: muted ? "muted" : undefined,
      };
    }
    if (!plainDefault) {
      return { ...c, channels: [], cadence: "immediate", required: false, suppressed: true, suppressReason: "no_default" };
    }
    const muted = isMutedNow(plainDefault.muteUntil);
    return {
      ...c,
      channels: plainDefault.channels as NotificationChannel[],
      cadence: plainDefault.cadence as NotificationCadence,
      required: false,
      suppressed: muted,
      suppressReason: muted ? "muted" : undefined,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Atomic enqueue (N6, N7). One short scope owns resolution reads AND  */
/* the Event+Delivery commits on both sqlite drivers, under the        */
/* declared-scope reservation contract (§1 correction 11): standalone  */
/* ⇒ drizzle db.transaction({behavior:"immediate"}); declared          */
/* reserved-immediate ⇒ SAVEPOINT join. An ACTIVE-but-undeclared outer */
/* scope (raw or managed, deferred or immediate) fails closed — typed   */
/* UNSUPPORTED_OUTER_SCOPE, zero writes. All audience/subscription     */
/* reads run INSIDE the scope (snapshot coherence); only               */
/* validateEventType + template render are outside (pure).             */
/* ------------------------------------------------------------------ */

export interface IntentCommand {
  habitatId: string;
  eventType: NotificationEventType;
  sourceType: NotificationSourceType;
  sourceId?: string;
  targetType?: NotificationTargetType;
  targetId?: string;
  severity: NotificationSeverity;
  title?: string;
  body?: string;
  payload?: Record<string, unknown>;
  createdByType: NotificationActorType;
  createdById?: string;
  intents: NotificationAudienceIntent[];
}

export interface IntentEnqueueResult {
  event: NotificationEvent;
  deliveries: NotificationDelivery[];
  outcome: "enqueued" | "event_only";
  emptyReasons: string[];
  suppressed: Array<{ recipientType: NotificationRecipientType; recipientId: string; reason: string }>;
}

/**
 * Writer-reservation scope (§1 correction 11). Omit for standalone enqueue
 * (the module reserves the writer itself). Pass `{ outer: "reserved-immediate" }`
 * ONLY from a caller that already holds `BEGIN IMMEDIATE` (census-pinned,
 * MIGRATION-TASKS §0) — the module verifies an active scope exists and
 * savepoint-joins; it never infers reservation from a probe.
 */
export interface IntentEnqueueScope {
  outer: "reserved-immediate";
}

export function enqueueNotificationWithIntents(
  command: IntentCommand,
  scope?: IntentEnqueueScope,
): IntentEnqueueResult {
  validateEventType(command.eventType); // pure — outside any DB scope
  const templateCtx: TemplateContext = {
    eventType: command.eventType,
    sourceType: command.sourceType,
    sourceId: command.sourceId,
    targetType: command.targetType,
    targetId: command.targetId,
    severity: command.severity,
    recipientType: "human",
    payload: command.payload,
  };
  const rendered = renderNotification(templateCtx); // pure — outside any DB scope

  const db = getDb();
  // Existence probe ONLY (never a reservation claim): a bare BEGIN fails
  // iff some transaction is active on the single connection; on success it
  // is rolled back immediately. Reservation comes from the declaration.
  let rawActive = false;
  try {
    db.run(sql`BEGIN`);
    db.run(sql`ROLLBACK`);
  } catch {
    rawActive = true;
  }
  if (rawActive && scope?.outer !== "reserved-immediate") {
    // Fail closed: an undeclared outer scope (deferred OR immediate, raw or
    // managed) must not be silently joined — the callee cannot verify its
    // reservation. Zero writes; the producer's own error path owns cleanup.
    throw new NotificationIntentError(
      "UNSUPPORTED_OUTER_SCOPE",
      "an outer transaction is active but not declared; pass { outer: 'reserved-immediate' } only from a caller that holds BEGIN IMMEDIATE",
    );
  }
  if (!rawActive && scope?.outer === "reserved-immediate") {
    throw new NotificationIntentError(
      "OUTER_SCOPE_NOT_ACTIVE",
      "outer:'reserved-immediate' declared but no transaction is active on the connection",
    );
  }

  // Suppressed/empty classification is computed INSIDE the scope (the same
  // snapshot that produced the writes) — never re-read after commit.
  const persist = (): {
    eventId: string;
    suppressed: IntentEnqueueResult["suppressed"];
    emptyReasons: string[];
  } => {
    const audience = resolveAudience({
      habitatId: command.habitatId,
      eventType: command.eventType,
      intents: command.intents,
    });
    const policy = resolveAudiencePolicy({
      habitatId: command.habitatId,
      eventType: command.eventType,
      candidates: audience.candidates,
    });
    const event = eventRepo.createNotificationEvent({
      habitatId: command.habitatId,
      eventType: command.eventType,
      sourceType: command.sourceType,
      sourceId: command.sourceId,
      targetType: command.targetType,
      targetId: command.targetId,
      severity: command.severity,
      title: command.title ?? rendered.title,
      body: command.body ?? rendered.body,
      payload: command.payload ?? rendered.payload,
      createdByType: command.createdByType,
      createdById: command.createdById,
    });
    let created = 0;
    const suppressed: IntentEnqueueResult["suppressed"] = [];
    const suppressedKeys = new Set<string>();
    const markSuppressed = (c: Candidate, reason: string) => {
      const key = `${c.recipientType}:${c.recipientId}`;
      if (suppressedKeys.has(key)) return;
      suppressedKeys.add(key);
      suppressed.push({ recipientType: c.recipientType, recipientId: c.recipientId, reason });
    };
    for (const p of policy) {
      if (p.suppressed) {
        markSuppressed(p, p.suppressReason ?? "unknown");
        continue;
      }
      deliveryRepo.createNotificationDelivery({
        eventId: event.id,
        habitatId: command.habitatId,
        recipientType: p.recipientType,
        recipientId: p.recipientId,
        required: p.required,
        channels: p.channels,
        cadence: p.cadence, // N5 end-to-end (§1 correction 12): resolved cadence — required default, override or plain default — is persisted as downstream scheduling authority (§2b column).
      });
      created += 1;
    }
    for (const r of audience.suppressedRemote) markSuppressed(r, "ineligible_remote");
    const emptyReasons =
      created === 0
        ? audience.candidates.length === 0
          ? [audience.emptyReason ?? "no_recipients"]
          : ["all_suppressed"]
        : [];
    return { eventId: event.id, suppressed, emptyReasons };
  };

  let done: ReturnType<typeof persist>;
  if (!rawActive) {
    done = db.transaction(() => persist(), { behavior: "immediate" }) as ReturnType<typeof persist>;
  } else {
    const sp = `orcy_intent_${randomUUID().replace(/-/g, "")}`;
    db.run(sql`SAVEPOINT ${sql.raw(`"${sp}"`)}`);
    try {
      done = persist();
      db.run(sql`RELEASE SAVEPOINT ${sql.raw(`"${sp}"`)}`);
    } catch (err) {
      try {
        db.run(sql`ROLLBACK TO SAVEPOINT ${sql.raw(`"${sp}"`)}`);
        db.run(sql`RELEASE SAVEPOINT ${sql.raw(`"${sp}"`)}`);
      } catch {
        // enclosing raw tx rolls back wholesale on its own error path
      }
      throw err;
    }
  }

  // Post-commit re-read — callers never see pre-aggregate rows.
  const event = eventRepo.getNotificationEventById(done.eventId);
  if (!event) throw new Error(`ENQUEUE_RESULT_LOST:${done.eventId}`);
  const deliveries = deliveryRepo.getDeliveriesByEvent(done.eventId);
  return {
    event,
    deliveries,
    outcome: deliveries.length > 0 ? "enqueued" : "event_only",
    emptyReasons: done.emptyReasons,
    suppressed: done.suppressed,
  };
}
