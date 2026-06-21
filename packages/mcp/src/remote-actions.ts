/**
 * v0.19 Phase D — Remote MCP action allowlist.
 *
 * Defines which actions are available to remote MCP clients. Actions NOT in
 * this list MUST fail with a clear error. This is the "explicit subset"
 * that remote mode exposes — the full local MCP tool surface is NOT
 * available to remote participants.
 *
 * Mapping is keyed by (action, scope) where scope is the resource the
 * action operates on (mission, task, etc.).
 */

export type RemoteMcpAction =
  // Discovery / read
  | "habitats.get"
  | "habitats.listMissions"
  | "missions.get"
  | "missions.getWorkflow"
  | "tasks.get"
  | "tasks.getWorkflowContext"
  | "tasks.listComments"
  | "missions.listComments"
  | "missions.listPulse"
  | "grants.list"
  | "credentials.current"
  | "notifications.list"
  | "notifications.history"
  // Comments (write — requires "comment" scope)
  | "tasks.addComment"
  | "missions.addComment"
  // Task lifecycle (write — requires appropriate scope)
  | "tasks.claim"
  | "tasks.heartbeat"
  | "tasks.submit"
  | "tasks.release"
  // Evidence (write — requires "evidence_link" scope, URL only)
  | "tasks.addEvidenceLink"
  // Pulse (write — requires "pulse.post" scope)
  | "missions.postPulse"
  // Notifications (write)
  | "notifications.ack"
  | "notifications.snooze";

/**
 * Map a remote MCP action to its HTTP method + path + body shape.
 * The body shape is what the client sends; the server validates with Zod.
 */
export interface RemoteActionDescriptor {
  method: "GET" | "POST";
  path: (params: Record<string, string>) => string;
  bodyFrom?: (params: Record<string, unknown>) => unknown;
  /**
   * The action_scope required for this endpoint. The remote participant's
   * grants must include this scope (verified server-side). The client uses
   * this for early refusal / messaging.
   */
  requiredScope:
    | "read"
    | "comment"
    | "claim"
    | "submit"
    | "release"
    | "heartbeat"
    | "evidence_link"
    | "pulse.post";
}

export const REMOTE_MCP_ACTIONS: Record<RemoteMcpAction, RemoteActionDescriptor> = {
  "habitats.get": {
    method: "GET",
    path: (p) => `/api/shared/habitats/${p.habitatId}`,
    requiredScope: "read",
  },
  "habitats.listMissions": {
    method: "GET",
    path: (p) => `/api/shared/habitats/${p.habitatId}/missions`,
    requiredScope: "read",
  },
  "missions.get": {
    method: "GET",
    path: (p) => `/api/shared/missions/${p.missionId}`,
    requiredScope: "read",
  },
  "missions.getWorkflow": {
    method: "GET",
    path: (p) => `/api/shared/missions/${p.missionId}/workflow`,
    requiredScope: "read",
  },
  "tasks.get": {
    method: "GET",
    path: (p) => `/api/shared/tasks/${p.taskId}`,
    requiredScope: "read",
  },
  "tasks.getWorkflowContext": {
    method: "GET",
    path: (p) => `/api/shared/tasks/${p.taskId}/workflow-context`,
    requiredScope: "read",
  },
  "tasks.listComments": {
    method: "GET",
    path: (p) => `/api/shared/tasks/${p.taskId}/comments`,
    requiredScope: "read",
  },
  "missions.listComments": {
    method: "GET",
    path: (p) => `/api/shared/missions/${p.missionId}/comments`,
    requiredScope: "read",
  },
  "missions.listPulse": {
    method: "GET",
    path: (p) => `/api/shared/missions/${p.missionId}/pulse`,
    requiredScope: "read",
  },
  "grants.list": {
    method: "GET",
    path: () => `/api/shared/grants`,
    requiredScope: "read",
  },
  "credentials.current": {
    method: "GET",
    path: () => `/api/shared/credentials/current`,
    requiredScope: "read",
  },
  "notifications.list": {
    method: "GET",
    path: () => `/api/shared/notifications`,
    requiredScope: "read",
  },
  "notifications.history": {
    method: "GET",
    path: () => `/api/shared/notifications/history`,
    requiredScope: "read",
  },
  "tasks.addComment": {
    method: "POST",
    path: (p) => `/api/shared/tasks/${p.taskId}/comments`,
    bodyFrom: (p) => ({ content: p.content, parentId: p.parentId }),
    requiredScope: "comment",
  },
  "missions.addComment": {
    method: "POST",
    path: (p) => `/api/shared/missions/${p.missionId}/comments`,
    bodyFrom: (p) => ({ content: p.content, parentId: p.parentId }),
    requiredScope: "comment",
  },
  "tasks.claim": {
    method: "POST",
    path: (p) => `/api/shared/tasks/${p.taskId}/claim`,
    bodyFrom: () => ({}),
    requiredScope: "claim",
  },
  "tasks.heartbeat": {
    method: "POST",
    path: (p) => `/api/shared/tasks/${p.taskId}/heartbeat`,
    bodyFrom: (p) => ({ progress: p.progress }),
    requiredScope: "heartbeat",
  },
  "tasks.submit": {
    method: "POST",
    path: (p) => `/api/shared/tasks/${p.taskId}/submit`,
    bodyFrom: (p) => ({ result: p.result, artifacts: p.artifacts ?? [] }),
    requiredScope: "submit",
  },
  "tasks.release": {
    method: "POST",
    path: (p) => `/api/shared/tasks/${p.taskId}/release`,
    bodyFrom: (p) => ({ reason: p.reason }),
    requiredScope: "release",
  },
  "tasks.addEvidenceLink": {
    method: "POST",
    path: (p) => `/api/shared/tasks/${p.taskId}/evidence-links`,
    bodyFrom: (p) => ({ url: p.url, metadata: p.metadata ?? {} }),
    requiredScope: "evidence_link",
  },
  "missions.postPulse": {
    method: "POST",
    path: (p) => `/api/shared/missions/${p.missionId}/pulse`,
    bodyFrom: (p) => ({
      signalType: p.signalType,
      subject: p.subject,
      body: p.body,
      taskId: p.taskId,
      replyToId: p.replyToId,
    }),
    requiredScope: "pulse.post",
  },
  "notifications.ack": {
    method: "POST",
    path: (p) => `/api/shared/notifications/deliveries/${p.deliveryId}/ack`,
    bodyFrom: () => ({}),
    requiredScope: "read",
  },
  "notifications.snooze": {
    method: "POST",
    path: (p) => `/api/shared/notifications/deliveries/${p.deliveryId}/snooze`,
    bodyFrom: (p) => ({ snoozedUntil: p.snoozedUntil }),
    requiredScope: "read",
  },
};

/**
 * Convenience type guard for whether a string is a known remote MCP action.
 */
export function isRemoteMcpAction(s: string): s is RemoteMcpAction {
  return Object.prototype.hasOwnProperty.call(REMOTE_MCP_ACTIONS, s);
}
