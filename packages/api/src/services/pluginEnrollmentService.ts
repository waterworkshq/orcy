import { z } from "zod";
import type { Contribution } from "@orcy/shared";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as runRepo from "../repositories/pluginRun.js";
import type { ListRunsFilter as RunListFilter } from "../repositories/pluginRun.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import type { PluginEnrollmentRow, PluginRunRow } from "../db/schema/index.js";

const DEFAULT_STALE_PLUGIN_RUN_MINUTES = 30;

export type StalePluginRun = PluginRunRow & { elapsedMinutes: number };
export interface StalePluginRunLogger {
  warn(data: Record<string, unknown>, message: string): void;
}

/** Reads the stale-run observability threshold from the environment, falling back to 30 minutes. */
export function getStalePluginRunThresholdMinutes(): number {
  const configured = process.env.ORCY_PLUGIN_STALE_RUN_MINUTES
    ? parseInt(process.env.ORCY_PLUGIN_STALE_RUN_MINUTES, 10)
    : DEFAULT_STALE_PLUGIN_RUN_MINUTES;
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_STALE_PLUGIN_RUN_MINUTES;
}

function staleThresholdIso(thresholdMinutes: number): string {
  return new Date(Date.now() - thresholdMinutes * 60_000).toISOString();
}

function withElapsedMinutes(row: PluginRunRow): StalePluginRun {
  return {
    ...row,
    elapsedMinutes: Math.floor((Date.now() - new Date(row.startedAt).getTime()) / 60_000),
  };
}

const createEnrollmentSchema = z.object({
  pluginId: z.string().min(1),
  contributionId: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

const updateEnrollmentSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

export type CreateEnrollmentInput = z.infer<typeof createEnrollmentSchema>;
export type UpdateEnrollmentPatch = z.infer<typeof updateEnrollmentSchema>;
export type ListRunsFilter = RunListFilter;

/**
 * Locates a contribution on a loaded plugin's manifest by id. The id field is
 * derived per-kind via `CATALOG[c.kind].label(c)`, so all 9 kinds are covered
 * from a single delegation point. Returns `null` if the plugin isn't loaded
 * or the contribution id is unknown. System-scoped kinds are returned so the
 * caller's scope check produces a meaningful "cannot enroll system-scoped"
 * error rather than a generic "not found".
 */
function findContribution(pluginId: string, contributionId: string): Contribution | null {
  const manifest = pluginManager.getPluginManifest(pluginId);
  if (!manifest) return null;
  for (const c of manifest.contributions) {
    if (pluginManager.CATALOG[c.kind].label(c) === contributionId) return c;
  }
  return null;
}

/**
 * Evaluates the `ORCY_DETECTOR_ALLOWLIST` env gate for a detector plugin id.
 * Fail-closed: unset → all detector enrollments rejected. `*` → allow all.
 * Otherwise a comma-separated allowlist of plugin ids.
 */
function detectorAllowed(pluginId: string): boolean {
  const allow = process.env.ORCY_DETECTOR_ALLOWLIST;
  if (!allow) return false;
  if (allow === "*") return true;
  const ids = allow
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(pluginId);
}

/** Validates `config` against a contribution's Zod configSchema, if declared. */
function validateConfig(
  contribution: Contribution,
  config: Record<string, unknown> | undefined,
): void {
  if (!("configSchema" in contribution) || !contribution.configSchema) return;
  const result = contribution.configSchema.safeParse(config ?? {});
  if (!result.success) {
    throw badRequest("Config validation failed", result.error.flatten());
  }
}

/**
 * Creates a new enrollment row for a habitat-scoped contribution. New rows
 * start `enabled = 0` — the habitat admin toggles via PATCH. Detector
 * contributions are gated by `ORCY_DETECTOR_ALLOWLIST` (fail-closed).
 */
export function createEnrollment(
  habitatId: string,
  input: CreateEnrollmentInput,
  enrolledBy: string,
): PluginEnrollmentRow {
  const parsed = createEnrollmentSchema.safeParse(input);
  if (!parsed.success) {
    throw badRequest("Validation failed", parsed.error.flatten());
  }

  const contribution = findContribution(parsed.data.pluginId, parsed.data.contributionId);
  if (!contribution) {
    throw badRequest(
      `Contribution '${parsed.data.contributionId}' not found on plugin '${parsed.data.pluginId}'`,
    );
  }
  if (contribution.scope !== "habitat") {
    throw badRequest("Cannot enroll system-scoped contributions");
  }
  // Only signalDetector and lifecycleInterceptor have scope: "habitat" (ADR-0011).
  // TypeScript's discriminated union enforces this at compile time after the scope check.
  if (contribution.kind === "signalDetector" && !detectorAllowed(parsed.data.pluginId)) {
    throw forbidden(`Plugin '${parsed.data.pluginId}' not allowed by ORCY_DETECTOR_ALLOWLIST`);
  }
  validateConfig(contribution, parsed.data.config);

  const row = enrollmentRepo.create({
    habitatId,
    pluginId: parsed.data.pluginId,
    contributionId: parsed.data.contributionId,
    contributionKind: contribution.kind,
    enabled: 0,
    config: parsed.data.config,
    enrolledBy,
  });
  pluginManager.invalidateEnrollmentCache(habitatId);
  // No SSE event on create — enrollment starts disabled (no loader impact).
  return row;
}

/**
 * Toggles enabled state and/or updates config on an existing enrollment.
 * Emits `plugin.enrollment_toggled` when `enabled` changes (the only state
 * transition that affects the loader dispatch set).
 */
export function updateEnrollment(
  habitatId: string,
  enrollmentId: string,
  patch: UpdateEnrollmentPatch,
): PluginEnrollmentRow {
  const parsed = updateEnrollmentSchema.safeParse(patch);
  if (!parsed.success) {
    throw badRequest("Validation failed", parsed.error.flatten());
  }

  const existing = enrollmentRepo.getById(enrollmentId);
  if (!existing || existing.habitatId !== habitatId) {
    throw notFound("Enrollment not found");
  }

  if (parsed.data.config !== undefined) {
    const contribution = findContribution(existing.pluginId, existing.contributionId);
    if (contribution) validateConfig(contribution, parsed.data.config);
  }

  const updatePatch: { enabled?: number; config?: Record<string, unknown> } = {};
  if (parsed.data.enabled !== undefined) {
    updatePatch.enabled = parsed.data.enabled ? 1 : 0;
  }
  if (parsed.data.config !== undefined) {
    updatePatch.config = parsed.data.config;
  }

  const updated = enrollmentRepo.update(enrollmentId, updatePatch);
  if (!updated) throw notFound("Enrollment not found");
  pluginManager.invalidateEnrollmentCache(habitatId);

  if (parsed.data.enabled !== undefined) {
    sseBroadcaster.publish(habitatId, {
      type: "plugin.enrollment_toggled",
      data: {
        habitatId,
        enrollmentId,
        pluginId: existing.pluginId,
        enabled: parsed.data.enabled,
      },
    });
  }

  return updated;
}

/** Lists all enrollments for a habitat (enabled and disabled). */
export function listEnrollments(habitatId: string): PluginEnrollmentRow[] {
  return enrollmentRepo.listByHabitat(habitatId);
}

/** Lists plugin run telemetry rows for a habitat with optional filters. */
export function listPluginRuns(habitatId: string, filter?: ListRunsFilter): PluginRunRow[] {
  return runRepo.listByHabitat(habitatId, filter);
}

/** Lists stale active runs for a habitat without changing their durable run status. */
export function listStalePluginRuns(habitatId: string, thresholdMinutes: number): StalePluginRun[] {
  return runRepo.findStaleRunning(staleThresholdIso(thresholdMinutes), habitatId).map(withElapsedMinutes);
}

/**
 * Emits an operator warning for every stale active run across habitats. This is
 * deliberately read-only: a durably launched run remains dedup-accounted for.
 */
export function scanStalePluginRuns(
  thresholdMinutes: number,
  log: StalePluginRunLogger,
): number {
  const staleRuns = runRepo.findStaleRunning(staleThresholdIso(thresholdMinutes));

  for (const row of staleRuns) {
    try {
      const staleRun = withElapsedMinutes(row);
      log.warn(
        {
          pluginId: staleRun.pluginId,
          contributionKind: staleRun.contributionKind,
          contributionId: staleRun.contributionId,
          triggerType: staleRun.triggerType,
          triggerEventId: staleRun.triggerEventId,
          runId: staleRun.id,
          startedAt: staleRun.startedAt,
          elapsedMinutes: staleRun.elapsedMinutes,
        },
        "Stale plugin run detected",
      );
    } catch {
      // A logger failure for one row must not prevent observability for the rest.
    }
  }

  return staleRuns.length;
}

/**
 * Permanently removes an enrollment row. Emits `plugin.enrollment_removed`
 * (distinct from disable, which keeps the row for re-enable).
 */
export function deleteEnrollment(habitatId: string, enrollmentId: string): boolean {
  const existing = enrollmentRepo.getById(enrollmentId);
  if (!existing || existing.habitatId !== habitatId) {
    throw notFound("Enrollment not found");
  }
  const deleted = enrollmentRepo.deleteEnrollment(enrollmentId);
  if (deleted) {
    pluginManager.invalidateEnrollmentCache(habitatId);
    sseBroadcaster.publish(habitatId, {
      type: "plugin.enrollment_removed",
      data: { habitatId, enrollmentId, pluginId: existing.pluginId },
    });
  }
  return deleted;
}
