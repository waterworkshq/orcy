import * as eventRepo from "../repositories/event.js";
import type { CreateEventInput } from "../repositories/events/event-crud.js";
import type { CreateMissionEventInput } from "../repositories/events/event-feature.js";

/** Persists a task lifecycle event to the audit store by delegating to the event repository. */
export function emitTaskAuditEvent(input: CreateEventInput) {
  return eventRepo.createEvent(input);
}

/** Persists a mission lifecycle event to the audit store by delegating to the event repository. */
export function emitMissionAuditEvent(input: CreateMissionEventInput) {
  return eventRepo.createMissionEvent(input);
}
