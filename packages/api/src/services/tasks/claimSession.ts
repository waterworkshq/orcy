/**
 * T1 — atomic claim + daemon-session composition.
 *
 * The api-internal seam both daemon transports (embedded
 * `InProcessClaimStrategy`, standalone `daemonEngine.claimNextDaemonTask`) use
 * to claim a task AND create its daemon session in ONE transaction. It delegates
 * to the SERVICE `claimTask` (task-lifecycle) with the authority's
 * `onClaimCommitted` hook, so the full service contract — capability guard,
 * `taskClaimed` pre-interceptor veto, `claimed` transition event + SSE +
 * watchers, post-interceptors — runs exactly as for the HTTP claim route. The
 * hook inserts the session via `createDaemonSessionWithClient` on the SAME tx:
 * a session INSERT failure (e.g. FK violation on a deleted daemon) rolls back
 * the claim with it AND suppresses every post-commit success effect —
 * task/agent/session stay coherent, nothing leaks.
 *
 * Dependency direction is api-internal only: this module closes over repo
 * primitives; the daemon package boundary is untouched.
 */
import { claimTask as serviceClaimTask } from "./task-lifecycle.js";
import { createDaemonSessionWithClient } from "../../repositories/daemonSession.js";
import type { CreateDaemonSessionInput } from "../../repositories/daemonSession.js";
import type { Task } from "../../models/index.js";

/** Input for {@link claimTaskWithSession}: the task, the claiming agent, and the daemon session row to create. */
export interface ClaimTaskWithSessionInput extends CreateDaemonSessionInput {
  agentId: string;
}

/**
 * Claims a task for `agentId` through the full service path and creates the
 * daemon session atomically. Returns `{success:true, task, daemonSessionId}`
 * (the session id is threaded out of the INSERT itself — exact-row by
 * construction, never re-queried) or the service's `{success:false, reason}`
 * shape. A hook throw becomes the authority's typed `infrastructure_failure`
 * → `claim_failed`, with no success effects emitted.
 */
export function claimTaskWithSession(
  taskId: string,
  input: ClaimTaskWithSessionInput,
):
  | { success: true; task: Task; daemonSessionId: string }
  | { success: false; reason: string } {
  // Closure-threaded session id: set by the in-tx hook, read only on the
  // success path. Exact inserted row by construction (createDaemonSessionWithClient
  // mints the uuid and returns it) — no post-commit taskId-only re-query, no
  // throw-on-missing window.
  let insertedSessionId: string | null = null;

  const result = serviceClaimTask(taskId, input.agentId, (tx, task) => {
    insertedSessionId = createDaemonSessionWithClient(tx, input, task.executionToken ?? "").id;
  });

  if (!result.success || !insertedSessionId) {
    return { success: false, reason: result.success ? "claim_failed" : result.reason };
  }
  return { success: true, task: result.task, daemonSessionId: insertedSessionId };
}
