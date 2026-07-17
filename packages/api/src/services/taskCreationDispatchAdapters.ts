/**
 * Creation Dispatch Adapters — DORMANT (T4B Phase 1).
 *
 * Six {@link DispatchTargetAdapter} implementations that WRAP the existing
 * fan-out mechanisms (sseBroadcaster, webhook/chat/automation delivery,
 * post-interceptors, transition subscribers) as event-ID-idempotent dispatch
 * adapters. Each correlates delivery to `envelope.eventId` (for receiver-side
 * dedup at-least-once), returns `{accepted}` once the underlying mechanism is
 * attempted / durably handed-off (NOT on external completion), and
 * `{attention, error}` on a runtime fault (no silent claimability).
 *
 * **Additive + dormant** — registered with the T4A registry but NEVER called in
 * production until cutover (T11). The live `createTask` / `transition-emitter`
 * fan-out is UNTOUCHED; these adapters activate only when an origin publishes
 * via T3C and the T4A dispatcher processes the envelope.
 *
 * Phase 1 covers the CREATE case (one `created` envelope, one signal per
 * consumer). Clone dual-signal / single-handoff is Phase 2.
 *
 * See: T4B ticket § "Phase 1 grounding" and the Technical Plan § "Post-Commit
 * Sequencing" (line 450 — required target classes; line 474 — `accepted`
 * semantics).
 */
import { taskCreationEnvelopes } from "../db/schema/index.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { dispatchWebhooks } from "./webhookDispatcher.js";
import { processEvent as chatProcessEvent } from "./chatService.js";
import { ingestEvent } from "./automationEventService.js";
import { runPostInterceptors } from "../plugins/pluginManager.js";
import { notifyTransition } from "./tasks/transition-emitter.js";
import type { TransitionContext } from "./tasks/transition-emitter.js";
import * as taskRepo from "../repositories/task.js";
import type { Task } from "../models/index.js";
import { logger } from "../lib/logger.js";
import {
  type DispatchTargetAdapter,
  type DispatchTargetAttemptOutcome,
  registerDispatchAdapter,
} from "./taskCreationDispatchRegistry.js";
import type { DispatchTargetInput } from "../repositories/taskPublication.js";

type EnvelopeRow = typeof taskCreationEnvelopes.$inferSelect;

// ---------------------------------------------------------------------------
// Target kind constants (kernel-fixed set — Technical Plan line 450)
// ---------------------------------------------------------------------------

export const CREATION_TARGET_KINDS = [
  "client_stream",
  "webhook",
  "chat",
  "automation",
  "post_interceptor",
  "transition_subscriber",
] as const;

export type CreationTargetKind = (typeof CREATION_TARGET_KINDS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the full {@link Task} from the envelope's `taskId`. Returns `null`
 * if the task does not exist (a data-integrity fault that the adapter surfaces
 * as `attention` — never silent claimability).
 */
function resolveTask(envelope: EnvelopeRow): Task | null {
  return taskRepo.getTaskById(envelope.taskId);
}

/**
 * Maps the envelope's `actorType` (which includes remote variants) to the
 * narrower `TransitionContext.actorType` union expected by
 * `runPostInterceptors` / `notifyTransition`.
 */
function envelopeActorType(envelope: EnvelopeRow): "agent" | "human" | "system" {
  switch (envelope.actorType) {
    case "human":
    case "remote_human":
      return "human";
    case "agent":
    case "remote_orcy":
      return "agent";
    default:
      return "system";
  }
}

/**
 * Builds the `TransitionContext` that `runPostInterceptors` and
 * `notifyTransition` expect, mirroring the shape `createTask` /
 * `emitTransition` constructs in the live path.
 */
function buildTransitionContext(envelope: EnvelopeRow, task?: Task): TransitionContext {
  return {
    actorType: envelopeActorType(envelope),
    actorId: envelope.actorId,
    newStatus: task?.status,
    task,
  };
}

function fault(kind: string, envelope: EnvelopeRow, err: unknown): DispatchTargetAttemptOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ err, targetKind: kind, eventId: envelope.eventId }, "Dispatch adapter fault");
  return { outcome: "attention", error: `${kind}: ${msg}` };
}

// ---------------------------------------------------------------------------
// 1. clientStreamAdapter — direct SSE push (ephemeral; fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Pushes the `task.created` SSE event to direct clients via
 * `sseBroadcaster.publish`. `accepted` once the publish is attempted — the
 * direct-client push is synchronous; the downstream webhook/chat/automation
 * fan-out the broadcaster triggers is fire-and-forget (durable ingress is the
 * downstream adapters' concern, not this one's).
 *
 * Wraps: `sseBroadcaster.publish(habitatId, { type: "task.created", data: task })`
 * — same call `emitTransition` → `publishSseForAction` makes for the `"created"`
 * action.
 */
export const clientStreamAdapter: DispatchTargetAdapter = {
  targetKind: "client_stream",
  attempt(envelope: EnvelopeRow): DispatchTargetAttemptOutcome {
    try {
      const task = resolveTask(envelope);
      if (!task) {
        return {
          outcome: "attention",
          error: `client_stream: task ${envelope.taskId} not found`,
        };
      }
      sseBroadcaster.publish(envelope.habitatId, { type: "task.created", data: task });
      return { outcome: "accepted" };
    } catch (err) {
      return fault("client_stream", envelope, err);
    }
  },
};

// ---------------------------------------------------------------------------
// 2. webhookAdapter — durable handoff to webhook delivery
// ---------------------------------------------------------------------------

/**
 * Hands off to the webhook delivery path (`dispatchWebhooks`), which creates
 * durable delivery records (`createDeliveryRecord`) per subscription and
 * handles retries via the retry processor. `accepted` once the handoff is
 * invoked — external HTTP delivery completion is NOT required.
 *
 * Wraps: `dispatchWebhooks(habitatId, { type: "task.created", data: task })`
 * — the same call `sseBroadcaster.publish` fires for webhook subscribers.
 */
export const webhookAdapter: DispatchTargetAdapter = {
  targetKind: "webhook",
  attempt(envelope: EnvelopeRow): DispatchTargetAttemptOutcome {
    try {
      const task = resolveTask(envelope);
      if (!task) {
        return {
          outcome: "attention",
          error: `webhook: task ${envelope.taskId} not found`,
        };
      }
      dispatchWebhooks(envelope.habitatId, { type: "task.created", data: task }).catch((err) => {
        logger.error({ err, eventId: envelope.eventId }, "Webhook dispatch error (adapter)");
      });
      return { outcome: "accepted" };
    } catch (err) {
      return fault("webhook", envelope, err);
    }
  },
};

// ---------------------------------------------------------------------------
// 3. chatAdapter — chat-integration notification handoff
// ---------------------------------------------------------------------------

/**
 * Hands off to the chat-integration notification path (`chatService.processEvent`),
 * which maps `task.created` to `task_created` and dispatches Slack/Discord
 * messages to enabled integrations. `accepted` once the handoff is invoked.
 *
 * Wraps: `chatProcessEvent("task.created", habitatId, data)` — the same call
 * `sseBroadcaster.publish` fires for chat integrations.
 */
export const chatAdapter: DispatchTargetAdapter = {
  targetKind: "chat",
  attempt(envelope: EnvelopeRow): DispatchTargetAttemptOutcome {
    try {
      const task = resolveTask(envelope);
      if (!task) {
        return {
          outcome: "attention",
          error: `chat: task ${envelope.taskId} not found`,
        };
      }
      chatProcessEvent(
        "task.created",
        envelope.habitatId,
        task as unknown as Record<string, unknown>,
      ).catch((err) => {
        logger.error({ err, eventId: envelope.eventId }, "Chat push error (adapter)");
      });
      return { outcome: "accepted" };
    } catch (err) {
      return fault("chat", envelope, err);
    }
  },
};

// ---------------------------------------------------------------------------
// 4. automationAdapter — automation event ingestion
// ---------------------------------------------------------------------------

/**
 * Hands off to the automation event service (`ingestEvent`), which matches the
 * event against the habitat's enabled automation rules. `accepted` once the
 * ingestion is invoked — rule matching / execution is the automation
 * subsystem's concern.
 *
 * Includes `envelope.eventId` in the event `data` so the receiver can dedup
 * (at-least-once) — `ingestEvent` already reads `data.eventId` for run
 * correlation.
 *
 * Wraps: `ingestEvent(habitatId, { type: "task.created", data })` — the same
 * call `sseBroadcaster.publish` fires for automation ingestion.
 *
 * Note: `task.created` is NOT currently in the `EVENT_ALLOWLIST`, so
 * `ingestEvent` returns `{ matched: 0, skipped: 0 }` without matching any
 * rules. The adapter still returns `{accepted}` — the durable ingress was
 * attempted; whether any rules match is the automation subsystem's policy.
 */
export const automationAdapter: DispatchTargetAdapter = {
  targetKind: "automation",
  attempt(envelope: EnvelopeRow): DispatchTargetAttemptOutcome {
    try {
      const task = resolveTask(envelope);
      const data: Record<string, unknown> = {
        taskId: envelope.taskId,
        eventId: envelope.eventId,
        habitatId: envelope.habitatId,
      };
      if (task) {
        data.id = task.id;
        data.title = task.title;
        data.status = task.status;
        data.priority = task.priority;
      }
      ingestEvent(envelope.habitatId, { type: "task.created", data }).catch((err) => {
        logger.error({ err, eventId: envelope.eventId }, "Automation ingestion error (adapter)");
      });
      return { outcome: "accepted" };
    } catch (err) {
      return fault("automation", envelope, err);
    }
  },
};

// ---------------------------------------------------------------------------
// 5. postInterceptorAdapter — plugin post-interceptor dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches the `taskCreated` post-interceptor run via
 * `pluginManager.runPostInterceptors`. `accepted` once the run is dispatched —
 * post-interceptor execution is fire-and-forget per ADR-0039.
 *
 * Wraps: `runPostInterceptors(taskId, "taskCreated", habitatId, context)` —
 * the same call `createTask` makes after the transition commits.
 */
export const postInterceptorAdapter: DispatchTargetAdapter = {
  targetKind: "post_interceptor",
  attempt(envelope: EnvelopeRow): DispatchTargetAttemptOutcome {
    try {
      const task = resolveTask(envelope);
      if (!task) {
        return {
          outcome: "attention",
          error: `post_interceptor: task ${envelope.taskId} not found`,
        };
      }
      runPostInterceptors(
        envelope.taskId,
        "taskCreated",
        envelope.habitatId,
        buildTransitionContext(envelope, task),
      );
      return { outcome: "accepted" };
    } catch (err) {
      return fault("post_interceptor", envelope, err);
    }
  },
};

// ---------------------------------------------------------------------------
// 6. transitionSubscriberAdapter — transition hook notification
// ---------------------------------------------------------------------------

/**
 * Notifies transition subscribers (`onTransition` hooks) via the exported
 * `notifyTransition`. `accepted` once subscribers are notified.
 *
 * Wraps: `notifyTransition({ taskId, action: "created", habitatId, ... })` —
 * the same call `emitTransition` makes at the end of its `"created"` branch.
 * Only the subscriber-notification concern is reproduced here; SSE / audit
 * events / mission recalc are handled by their respective adapters or the T3C
 * publication step.
 */
export const transitionSubscriberAdapter: DispatchTargetAdapter = {
  targetKind: "transition_subscriber",
  attempt(envelope: EnvelopeRow): DispatchTargetAttemptOutcome {
    try {
      const task = resolveTask(envelope);
      const actorType = envelopeActorType(envelope);
      notifyTransition({
        taskId: envelope.taskId,
        action: "created",
        habitatId: envelope.habitatId,
        actorType,
        actorId: envelope.actorId,
        newStatus: task?.status,
        task: task ?? undefined,
      });
      return { outcome: "accepted" };
    } catch (err) {
      return fault("transition_subscriber", envelope, err);
    }
  },
};

// ---------------------------------------------------------------------------
// defaultCreationDispatchPlan
// ---------------------------------------------------------------------------

/**
 * The list of required dispatch targets for a creation envelope (Technical
 * Plan line 450 — the kernel-fixed set). `targetKey` is the routing key
 * (`habitatId` for all creation consumers — they all route per-habitat).
 *
 * The publication flow uses this to populate the dispatch plan without each
 * origin knowing the internal target kinds.
 */
export function defaultCreationDispatchPlan(envelope: EnvelopeRow): DispatchTargetInput[] {
  return CREATION_TARGET_KINDS.map((targetKind) => ({
    targetKind,
    targetKey: envelope.habitatId,
  }));
}

// ---------------------------------------------------------------------------
// registerCreationDispatchAdapters
// ---------------------------------------------------------------------------

const ALL_ADAPTERS: DispatchTargetAdapter[] = [
  clientStreamAdapter,
  webhookAdapter,
  chatAdapter,
  automationAdapter,
  postInterceptorAdapter,
  transitionSubscriberAdapter,
];

let creationAdaptersRegistered = false;

/**
 * Registers all six creation dispatch adapters with the T4A registry.
 * Idempotent — safe to call multiple times (last-writer-wins per kind).
 *
 * After registration, `resolveDispatchAdapter` resolves each of the 6 creation
 * target kinds. Called at boot in the dormant build; NO production origin
 * publishes via T3C until cutover, so these adapters are never invoked.
 */
export function registerCreationDispatchAdapters(): void {
  for (const adapter of ALL_ADAPTERS) {
    registerDispatchAdapter(adapter);
  }
  creationAdaptersRegistered = true;
}

/**
 * Returns whether {@link registerCreationDispatchAdapters} has been called.
 * Test-only convenience; production code should not depend on this.
 */
export function areCreationDispatchAdaptersRegistered(): boolean {
  return creationAdaptersRegistered;
}
