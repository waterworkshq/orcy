/**
 * Fix-P1 — Cutover gate for the post-cutover Task-creation mutation routes
 * (HISTORICAL — superseded by the v0.32.0 cutover landing; retained for the
 * git-history narrative). The {@link isCreationPublicationEnabled} function
 * below permanently returns `true` since v0.32.0; the routes it once gated
 * are now registered unconditionally and the legacy create/clone REST
 * surfaces have been retired.
 *
 * Historical context — The 4 mutation routes that create/modify POST_CUTOVER
 * state were dormant in production until T11 (Story 3 cutover) flipped this
 * flag on:
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
 * Read at route-registration time (inside the assembly's `registerApiRoutes`
 * in `httpApp.ts` + `taskRoutes` in `routes/tasks/index.ts`); toggling requires a process
 * restart — routes are fixed for the process lifetime once registered, the
 * same way `ORCY_AUTOMATION_EXECUTE_ACTIONS` is read per-call but effectively
 * fixed within a boot cycle for route registration.
 *
 * Read-only recovery routes (`GET /task-creation-attempts/:attemptId`,
 * `GET /tasks/:sourceTaskId/clone-preparation`) are NOT gated — they are safe
 * to mount unconditionally (no writes, no POST_CUTOVER state creation).
 */
/**
 * Returns whether the creation publication kernel is active. Always true —
 * the kernel is the sole Task-creation path as of v0.32.0. The function is
 * retained for backward-compatible imports; the env-var gate was removed
 * during the cutover cleanup.
 */
export function isCreationPublicationEnabled(): boolean {
  return true;
}

/**
 * The default deadline for targeted assignment recovery, in milliseconds.
 *
 * When a Task is published with `assignment.kind === "targeted"` but no
 * explicit `targetedAssignmentDeadline`, the publication adapters fall
 * back to this value. The deadline bounds how long the assignment
 * reservation stays active before releasing to `created_unassigned`.
 *
 * Config-backed via `ORCY_ASSIGNMENT_DEADLINE_MS` (parsed as an integer;
 * invalid/missing values fall back to 24h). Read per-call so operators
 * can tune without a process restart (unlike the cutover flag which is
 * route-registration-scoped).
 *
 * @default 86_400_000 (24 hours)
 */
export function getDefaultAssignmentDeadlineMs(): number {
  const raw = process.env.ORCY_ASSIGNMENT_DEADLINE_MS;
  if (raw === undefined || raw === "") return 86_400_000; // 24h
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 86_400_000; // 24h
  return parsed;
}
