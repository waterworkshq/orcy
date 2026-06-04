import * as eventRepo from "../repositories/event.js";
import type { CreateEventInput } from "../repositories/events/event-crud.js";
import type { CreateMissionEventInput } from "../repositories/events/event-feature.js";

export function emitTaskAuditEvent(input: CreateEventInput) {
  return eventRepo.createEvent(input);
}

export function emitMissionAuditEvent(input: CreateMissionEventInput) {
  return eventRepo.createMissionEvent(input);
}
