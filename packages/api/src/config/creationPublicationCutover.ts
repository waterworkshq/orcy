/**
 * Fix-P1 — Cutover gate for the post-cutover Task-creation mutation routes.
 *
 * The 4 mutation routes that create/modify POST_CUTOVER state are dormant in
 * production until T11 (Story 3 cutover) flips this flag on:
 *   - `POST /missions/:missionId/task-publications`
 *   - `POST /tasks/:sourceTaskId/clone-publications`
 *   - `POST /tasks/:taskId/assignment-attempts`
 *   - `POST /scheduled-occurrences/:id/retry` (T9B Phase 3 — operator-facing
 *     scheduled-occurrence repair; creates NEW per-Task creation attempts
 *     under a retry-scoped key set + publishes via the milestone-1 publisher).
 *
 * Mirrors the `ORCY_AUTOMATION_EXECUTE_ACTIONS` kill-switch convention
 * (`shouldExecuteActions` in `services/automationExecutor.ts`) but INVERTED:
 * this flag is OPT-IN (default off) — the 4 mutation routes are unreachable
 * in production by default. When the flag is off, the routes are NOT
 * registered (a request 404s — true dormancy, not a runtime gate). When on
 * (T11 / tests), they register and behave as today.
 *
 * Read at route-registration time (inside `registerApiRoutes` in `index.ts`
 * + `taskRoutes` in `routes/tasks/index.ts`); toggling requires a process
 * restart — routes are fixed for the process lifetime once registered, the
 * same way `ORCY_AUTOMATION_EXECUTE_ACTIONS` is read per-call but effectively
 * fixed within a boot cycle for route registration.
 *
 * Read-only recovery routes (`GET /task-creation-attempts/:attemptId`,
 * `GET /tasks/:sourceTaskId/clone-preparation`) are NOT gated — they are safe
 * to mount unconditionally (no writes, no POST_CUTOVER state creation).
 */
export function isCreationPublicationEnabled(): boolean {
  return process.env.ORCY_CREATION_PUBLICATION_ENABLED === "true";
}
