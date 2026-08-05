/**
 * Remote-originated notification helpers.
 *
 * Relocated from `routes/sharedApi.ts` (T5a) so service-layer modules can emit
 * remote-participant-originated notifications without importing from a route
 * file. The two functions — {@link emitRemoteOriginatedNotification} and
 * {@link dispatchRemoteWebhook} — are unchanged in behavior; only their home
 * moved.
 */
import * as notificationCommandService from "./notificationCommandService.js";
import {
  dispatchCompactRemoteEvent,
  buildDispatchInputFromRemoteAction,
} from "./compactRemoteWebhookDispatcher.js";

/** Options for {@link emitRemoteOriginatedNotification}. */
export interface EmitRemoteOriginatedNotificationOpts {
  habitatId: string;
  eventType: "task.assigned" | "task.review_requested" | "task.blocked" | "pulse.signal_posted";
  sourceType: "task" | "mission" | "pulse";
  sourceId?: string;
  targetType?: "task" | "mission" | "habitat";
  targetId?: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  actorType: "remote_human" | "remote_orcy";
  actorId: string;
  podId?: string;
  explicitRecipients?: Array<{
    recipientType: "remote_human" | "remote_orcy";
    recipientId: string;
  }>;
}

/**
 * Phase E — Producer helper for remote-participant-originated events.
 * Emits a notification for the given event type. The remote notification
 * resolver (services/remoteNotificationResolver.ts) will find any other
 * remote participants/pods whose grants cover the event's target and
 * include them as recipients. Local human/agent recipients are not in
 * scope here — those are emitted by the existing V2 paths.
 */
export function emitRemoteOriginatedNotification(opts: EmitRemoteOriginatedNotificationOpts) {
  try {
    notificationCommandService.enqueueNotification({
      habitatId: opts.habitatId,
      eventType: opts.eventType,
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
      targetType: opts.targetType,
      targetId: opts.targetId,
      severity: opts.severity,
      title: opts.title,
      body: opts.body,
      payload: opts.payload,
      createdByType: opts.actorType,
      createdById: opts.actorId,
      explicitRecipients: opts.explicitRecipients,
    });
  } catch (err) {
    // Notifications are best-effort. A failure to enqueue should not
    // fail the originating remote action.
    // eslint-disable-next-line no-console
    console.error("[remoteNotifications] failed to enqueue remote notification:", err);
  }

  // Also fire a compact remote webhook dispatch (best-effort, async)
  void dispatchRemoteWebhook(opts);
}

/** Options for {@link dispatchRemoteWebhook}. */
export interface DispatchRemoteWebhookOpts {
  habitatId: string;
  eventType: "task.assigned" | "task.review_requested" | "task.blocked" | "pulse.signal_posted";
  actorType: "remote_human" | "remote_orcy";
  actorId: string;
  podId?: string;
  targetType?: "task" | "mission" | "habitat";
  targetId?: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
}

function dispatchRemoteWebhook(opts: DispatchRemoteWebhookOpts) {
  const baseUrl = process.env.ORCY_PUBLIC_URL ?? process.env.ORCY_BASE_URL ?? "";
  if (!baseUrl) return;
  const apiBase = `${baseUrl.replace(/\/$/, "")}/api/shared`;

  const { input } = buildDispatchInputFromRemoteAction({
    habitatId: opts.habitatId,
    eventType: opts.eventType,
    apiBase,
    participantId: opts.actorId,
    podId: opts.podId ?? "",
    standing: "remote_contributor",
    actionKind: opts.eventType === "task.review_requested" ? "execution" : "advisory",
    title: opts.title,
    body: opts.body,
    missionId: opts.targetType === "mission" ? opts.targetId : undefined,
    taskId: opts.targetType === "task" ? opts.targetId : undefined,
    metadata: opts.payload,
  });

  dispatchCompactRemoteEvent(input).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[remoteNotifications] failed to dispatch remote webhook:", err);
  });
}
