import type { AuditCompletenessSummary, AuditEvent } from "@orcy/shared/types";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { daysAgoISO } from "./analyticsDate.js";
import { dirname, join } from "path";
import { logger } from "../lib/logger.js";
import { queryAuditEvents, summarizeAuditCompleteness } from "./auditQueryService.js";
import {
  deleteArchivedMissionEvent,
  deleteArchivedTaskEvent,
  getHabitatEventRetention,
  listHabitatIdsForArchival,
} from "../repositories/auditArchival.js";

function findWorkspaceRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

const workspaceRoot = findWorkspaceRoot(import.meta.dirname);
const ARCHIVES_DIR = process.env.ARCHIVES_DIR || join(workspaceRoot, "archives");

interface AuditArchiveFile {
  schemaVersion: 2;
  metadata: {
    habitatId: string;
    generatedAt: string;
    sourceRange: { until: string };
    eventCount: number;
    completenessSummary: AuditCompletenessSummary;
  };
  events: AuditEvent[];
}

export interface ArchiveResult {
  archivedCount: number;
  archivePath: string;
}

function readExistingArchive(archivePath: string): AuditEvent[] {
  if (!existsSync(archivePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(archivePath, "utf-8")) as unknown;
    if (Array.isArray(parsed)) return parsed as AuditEvent[];
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).events)) {
      return (parsed as { events: AuditEvent[] }).events;
    }
  } catch (err) {
    logger.warn({ err, archivePath }, "Failed to read/parse existing archive file, starting fresh");
  }
  return [];
}

function extractProjectedSourceId(
  eventId: string,
  prefix: "task_event" | "mission_event",
): string | null {
  const fullPrefix = `${prefix}:`;
  return eventId.startsWith(fullPrefix) ? eventId.slice(fullPrefix.length) : null;
}

function buildArchiveFile(
  habitatId: string,
  cutoff: string,
  events: AuditEvent[],
): AuditArchiveFile {
  return {
    schemaVersion: 2,
    metadata: {
      habitatId,
      generatedAt: new Date().toISOString(),
      sourceRange: { until: cutoff },
      eventCount: events.length,
      completenessSummary: summarizeAuditCompleteness(events),
    },
    events,
  };
}

export function getRetentionSettings(habitatId: string): { eventRetentionDays: number } {
  const row = getHabitatEventRetention(habitatId);
  return { eventRetentionDays: row?.eventRetentionDays ?? 90 };
}

export function archiveOldEvents(habitatId: string): ArchiveResult {
  const { eventRetentionDays } = getRetentionSettings(habitatId);
  const cutoff = daysAgoISO(eventRetentionDays);
  const taskResult = queryAuditEvents({
    habitatId,
    until: cutoff,
    entityType: "task",
    order: "asc",
  });
  const missionResult = queryAuditEvents({
    habitatId,
    until: cutoff,
    entityType: "mission",
    order: "asc",
  });
  const events = [...taskResult.events, ...missionResult.events].toSorted((a, b) => {
    const time = a.occurredAt.localeCompare(b.occurredAt);
    if (time !== 0) return time;
    return a.id.localeCompare(b.id);
  });

  if (events.length === 0) {
    return { archivedCount: 0, archivePath: "" };
  }

  const habitatDir = join(ARCHIVES_DIR, habitatId);
  if (!existsSync(habitatDir)) mkdirSync(habitatDir, { recursive: true });

  const date = new Date().toISOString().split("T")[0];
  const archivePath = join(habitatDir, `${date}.json`);
  const existing = readExistingArchive(archivePath);
  const mergedEvents = [...existing, ...events];
  const archiveFile = buildArchiveFile(habitatId, cutoff, mergedEvents);

  writeFileSync(archivePath, JSON.stringify(archiveFile, null, 2));

  for (const event of events) {
    const taskEventId = extractProjectedSourceId(event.id, "task_event");
    if (taskEventId) deleteArchivedTaskEvent(taskEventId);
    const missionEventId = extractProjectedSourceId(event.id, "mission_event");
    if (missionEventId) deleteArchivedMissionEvent(missionEventId);
  }

  return { archivedCount: events.length, archivePath };
}

export function archiveAllHabitats(): ArchiveResult[] {
  const results: ArchiveResult[] = [];
  const habitatIds = listHabitatIdsForArchival();
  for (const habitatId of habitatIds) {
    const result = archiveOldEvents(habitatId);
    if (result.archivedCount > 0) results.push(result);
  }
  return results;
}
