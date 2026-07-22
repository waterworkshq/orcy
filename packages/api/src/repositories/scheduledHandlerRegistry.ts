/**
 * Scheduled Task Handler Registry — the `handlerKey → handler` Map (DORMANT-safe).
 *
 * Owns the in-process dispatch table that maps a schedule row's `handlerKey`
 * to the JS handler that fires when the schedule is due. The registry is a
 * plain `Map<string, ScheduledTaskHandler>` + two accessors
 * ({@link registerScheduledTaskHandler} / {@link getScheduledTaskHandler}) +
 * the handler-contract types. NO SSE, NO logger, NO `getDb()` — the module
 * is deliberately load-graph-light so the dispatch adapter
 * (`services/scheduledHandlerDispatch.ts`) can import the lookup without
 * pulling `scheduledTaskService`'s SSE/logger dependencies into the
 * publication path. The same layering discipline Phase 2/3 followed (see
 * `scheduledOccurrencePublication.ts:608-614` for the
 * `substituteTokens` inlining precedent).
 *
 * # Why a dedicated module (the registry refactor)
 *
 * `services/scheduledTaskService.ts` historically owned this registry
 * in-module. The new dispatch adapter needs to look up handlers WITHOUT
 * coupling to `scheduledTaskService`'s load graph. The fix: move the Map +
 * the handler-contract types + the two accessors here, and have
 * `scheduledTaskService.ts` RE-EXPORT `registerScheduledTaskHandler` +
 * `getScheduledTaskHandler` + `WIKI_CADENCE_HANDLER_KEY` +
 * `ScheduledTaskHandlerResult` / `ScheduledTaskHandler` for backwards
 * compatibility (`wikiSchedulerService.initWikiScheduler:371` and any future
 * registrars keep working unchanged via `import * as scheduledTaskService`).
 *
 * This is a small additive refactor of `scheduledTaskService.ts` (a move +
 * re-export), NOT a kernel-hub modification. `scheduledTaskService` is the
 * legacy path being replaced; it's not in the publication-kernel do-not-
 * modify list.
 *
 * # Concurrency
 *
 * The Map is process-local. Registrations happen at boot (single-threaded);
 * lookups happen during occurrence publication. The Map is NOT shared across
 * processes — each process registers its own handlers at boot. This mirrors
 * the dispatch-adapter registration pattern (`registerCreationDispatchAdapters`).
 *
 * # Boot-registration order (T11 wiring)
 *
 * `initWikiScheduler()` (and any future handler registrar) MUST run before
 * any handlerKey occurrence fires. Already true today; T11 makes it explicit
 * in the boot wiring. A firing before the registrar runs surfaces as the
 * terminal `handler_not_registered` outcome (preserves the legacy
 * fail-loud guard semantics at `scheduledTaskService.ts:172-184`).
 *
 * See: `services/scheduledHandlerDispatch.ts` (the dispatch adapter);
 * `services/scheduledTaskService.ts` (re-exports for backwards compat);
 * `services/wikiSchedulerService.ts:370` (the one production registrar).
 */
import type { ScheduledTask } from "../models/index.js";

// ---------------------------------------------------------------------------
// Handler contract types
// ---------------------------------------------------------------------------

/**
 * Result returned by a registered {@link ScheduledTaskHandler}. `missionId`
 * is optional — handlers that spawn work without creating a mission (e.g.
 * the wiki cadence handler, which spawns further `scheduled_tasks` rows via
 * `runCadence`) leave it unset. The dispatch path does NOT link the optional
 * `missionId` to the occurrence's `createdMissionId` column (handlers that
 * spawn children are separate firings with their own occurrences); the
 * `handlerResult` is preserved verbatim in the occurrence's result JSON for
 * audit.
 */
export interface ScheduledTaskHandlerResult {
  success: boolean;
  error?: string;
  missionId?: string;
}

/**
 * A custom handler invoked when a due scheduled task carries a `handlerKey`
 * that matches a registered handler, instead of the default mission-from-
 * template creation path. This lets domain services (wiki cadence) hook
 * into the scheduler without `scheduledTaskService` depending on them.
 *
 * Contract: handlers MUST be idempotent under re-dispatch. T9B's recovery
 * worker re-drives `publishing` occurrences on expired leases; a handler
 * that mutates external state must tolerate being called more than once for
 * the same schedule firing. (The wiki-cadence handler is currently NOT
 * idempotent in the recovery window — its spawned-child schedules are not
 * deduped by name. That regression is closed by a separate milestone that
 * ships alongside the dispatch path.)
 */
export type ScheduledTaskHandler = (schedule: ScheduledTask) => ScheduledTaskHandlerResult;

// ---------------------------------------------------------------------------
// Registry constants
// ---------------------------------------------------------------------------

/**
 * Dispatch key for the wiki cadence handler (registered by
 * `wikiSchedulerService.initWikiScheduler`). The one production handler
 * registered today.
 */
export const WIKI_CADENCE_HANDLER_KEY = "wiki-cadence";

// ---------------------------------------------------------------------------
// Registry Map + accessors
// ---------------------------------------------------------------------------

/**
 * handlerKey → handler registry, populated by domain services at boot via
 * {@link registerScheduledTaskHandler}. Process-local; registrations happen
 * at boot, lookups happen during occurrence publication.
 */
const scheduledTaskHandlers = new Map<string, ScheduledTaskHandler>();

/**
 * Registers a handler invoked when a due scheduled task's `handlerKey`
 * equals `handlerKey`. The handler replaces the default mission-from-template
 * execution for matching schedules. Domain services register their handlers
 * at boot (see `wikiSchedulerService.initWikiScheduler`). This is explicit
 * dispatch keyed on the schedule's declared `handler_key` column — no
 * name-prefix matching, so renaming a schedule's name can never silently
 * break dispatch.
 */
export function registerScheduledTaskHandler(
  handlerKey: string,
  handler: ScheduledTaskHandler,
): void {
  scheduledTaskHandlers.set(handlerKey, handler);
}

/**
 * Returns the registered handler for `handlerKey`, or `null` when none is
 * registered. The dispatch adapter calls this to look up the handler for a
 * due `handlerKey` schedule; the legacy `executeScheduledTask` path also
 * calls this (via the re-export from `scheduledTaskService.ts`) so its
 * handlerKey branch stays byte-identical behind the flag.
 */
export function getScheduledTaskHandler(handlerKey: string): ScheduledTaskHandler | null {
  return scheduledTaskHandlers.get(handlerKey) ?? null;
}
