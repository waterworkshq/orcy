/**
 * habitatSettings domain handler — the habitat-level planning config.
 *
 * The smallest of the 8 handlers: name/description string shape + settings
 * JSON shape. NO cross-domain references (habitatSettings is the root domain
 * — nothing to resolve). The prepare phase allocates exactly ONE prospective
 * server ID (the habitat's own id, when `mode:"new"`); resolveReferences is
 * a structural no-op.
 *
 * # Validation rules (accumulate, never first-error)
 *
 *   - `data.name` is a non-empty string.
 *   - `data.description` is a string (may be empty).
 *   - `data.settings` is a plain JSON object (Record<string, unknown>).
 *   - `data.sourceId` is a non-empty string.
 *
 * # Forbidden fields
 *
 * Per the C4 absorption table, NO execution state, security material, or
 * runtime configuration is portable content for habitatSettings. The handler
 * defensively re-verifies the absence of forbidden fields (the legacy adapter
 * M2 strips them; the handler is the second-layer guard).
 *
 * @see packages/api/src/services/importManifest/domainHandler.ts for the
 *      shared interface contract.
 */
import type { DomainEnvelope, HabitatSettingsPortable } from "../types.js";
import type {
  AppliedDomain,
  ApplyContext,
  DomainError,
  DomainHandler,
  DomainValidationResult,
  IdentityMap,
  ManifestContext,
  ReferenceResolution,
} from "../domainHandler.js";
import {
  allocateServerId,
  domainError,
  resolutionErr,
  resolutionOk,
  validationErr,
  validationOk,
} from "../domainHandler.js";
import { habitats } from "../../../db/schema/habitat.js";
import type { TaskPublicationDbClient } from "../../../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Validated + prepared shapes
// ---------------------------------------------------------------------------

/**
 * The validated habitatSettings payload — type-narrowed from the raw envelope
 * data. Carries the same fields as {@link HabitatSettingsPortable} (the
 * validate phase is shape + forbidden-field-absence verification; no
 * transformation).
 */
export interface ValidatedHabitatSettings {
  sourceId: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
}

/**
 * The prepared habitatSettings payload — the validated data + the prospective
 * server ID for the habitat (allocated during prepare). When `mode:"new"`,
 * the orchestrator uses this server ID as the prospective habitat id; when
 * `mode:"replacement"`, the server ID is allocated but the existing habitat
 * id is what T10B applies against (the prospective id is for idMap
 * completeness only).
 */
export interface PreparedHabitatSettings {
  sourceId: string;
  /** The prospective server-side habitat id (allocated in prepare). */
  habitatServerId: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Forbidden fields (C4 defensive re-verification)
// ---------------------------------------------------------------------------

/**
 * Fields that MUST NOT appear on a v3 habitatSettings payload (per the C4
 * absorption table). The legacy adapter (M2) strips these; the handler is the
 * second-layer guard (defensive — never silently carry forbidden material).
 */
const FORBIDDEN_HABITAT_SETTINGS_FIELDS = [
  "version",
  "exportedAt",
  "habitatId",
  "createdAt",
  "updatedAt",
  "createdBy",
] as const;

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * Validates the habitatSettings envelope's shape. Accumulates ALL
 * independently discoverable failures (per the plan's preflight discipline).
 */
export function validateHabitatSettings(
  envelope: DomainEnvelope<unknown>,
  _ctx: ManifestContext,
  _idMap: IdentityMap,
): DomainValidationResult<ValidatedHabitatSettings> {
  const errors: DomainError[] = [];
  const data = envelope.data as Record<string, unknown>;

  // Shape: sourceId
  if (typeof data.sourceId !== "string" || data.sourceId.length === 0) {
    errors.push(
      domainError("habitatSettings", "invalid_source_id", "sourceId must be a non-empty string", {
        actual: typeof data.sourceId,
        fieldPath: ["sourceId"],
      }),
    );
  }

  // Shape: name
  if (typeof data.name !== "string" || data.name.length === 0) {
    errors.push(
      domainError("habitatSettings", "invalid_name", "name must be a non-empty string", {
        actual: typeof data.name,
        fieldPath: ["name"],
      }),
    );
  }

  // Shape: description (may be empty)
  if (typeof data.description !== "string") {
    errors.push(
      domainError("habitatSettings", "invalid_description", "description must be a string", {
        actual: typeof data.description,
        fieldPath: ["description"],
      }),
    );
  }

  // Shape: settings (a plain JSON object)
  if (data.settings === null || typeof data.settings !== "object" || Array.isArray(data.settings)) {
    errors.push(
      domainError("habitatSettings", "invalid_settings", "settings must be a plain JSON object", {
        actual:
          data.settings === null
            ? "null"
            : Array.isArray(data.settings)
              ? "array"
              : typeof data.settings,
        fieldPath: ["settings"],
      }),
    );
  }

  // Forbidden-field absence (C4 defensive re-verification)
  for (const forbidden of FORBIDDEN_HABITAT_SETTINGS_FIELDS) {
    if (data[forbidden] !== undefined) {
      errors.push(
        domainError(
          "habitatSettings",
          "forbidden_field_present",
          `forbidden field '${forbidden}' must not appear on habitatSettings (C4 absorption: the adapter should have stripped it)`,
          { fieldPath: [forbidden] },
        ),
      );
    }
  }

  if (errors.length > 0) return validationErr(errors);

  return validationOk({
    sourceId: data.sourceId as string,
    name: data.name as string,
    description: data.description as string,
    settings: data.settings as Record<string, unknown>,
  });
}

// ---------------------------------------------------------------------------
// Prepare (PURE — no DB writes)
// ---------------------------------------------------------------------------

/**
 * Prepares the habitatSettings domain: allocates the prospective habitat
 * server ID into the idMap and produces the prepared payload. PURE +
 * IDEMPOTENT (re-running reuses the already-allocated server ID via
 * {@link allocateServerId}).
 */
export function prepareHabitatSettings(
  validated: ValidatedHabitatSettings,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): PreparedHabitatSettings {
  const habitatServerId = allocateServerId(idMap, validated.sourceId);
  return {
    sourceId: validated.sourceId,
    habitatServerId,
    name: validated.name,
    description: validated.description,
    settings: validated.settings,
  };
}

// ---------------------------------------------------------------------------
// Resolve references (PURE — habitatSettings has no cross-domain refs)
// ---------------------------------------------------------------------------

/**
 * Resolves habitatSettings references. habitatSettings is the root domain —
 * it has NO cross-domain references to rewrite. The phase exists for
 * interface uniformity: it returns the prepared payload unchanged (a
 * structural no-op).
 *
 * # Why a no-op resolveReferences
 *
 * The handler interface mandates a resolveReferences phase, but
 * habitatSettings has no sourceIds to rewrite (it references nothing). The
 * no-op return keeps the orchestrator's iteration uniform (every domain has
 * three phases; the orchestrator doesn't special-case the root).
 */
export function resolveHabitatSettingsReferences(
  prepared: PreparedHabitatSettings,
  _ctx: ManifestContext,
  _idMap: IdentityMap,
): ReferenceResolution<PreparedHabitatSettings> {
  return resolutionOk(prepared);
}

// ---------------------------------------------------------------------------
// Apply (T10B M1 — caller-owned tx; `mode:"new"` INSERT path)
// ---------------------------------------------------------------------------

/**
 * Writes the habitat settings row for `mode:"new"` imports. Inserts the
 * prospective habitat id (allocated in {@link prepareHabitatSettings}) into
 * the `habitats` table on the caller-owned tx client.
 *
 * # M1 scope (the `new` path)
 *
 * For `mode:"new"`, the habitat is freshly created — one INSERT into
 * `habitats` carrying the prepared id, name, description, and the caller's
 * `actor.id` as `createdBy`. The M2 orchestrator owns the in-place logic for
 * `mode:"replacement"` (UPDATE habitats SET name=…, description=… for
 * `replace` dispose; no-op for `preserve`); M1's apply throws if it sees
 * `mode:"replacement"` so the missing path is loud in tests.
 *
 * # Caller-owned tx (load-bearing)
 *
 * Receives a {@link TaskPublicationDbClient} from the orchestrator. NEVER
 * calls `getDb()` — the apply must run on the orchestrator's transactional
 * client so the whole aggregate commits (or rolls back) atomically. NEVER
 * emits external effects (SSE / hooks / webhooks).
 */
export function applyHabitatSettings(
  tx: TaskPublicationDbClient,
  prepared: PreparedHabitatSettings,
  ctx: ApplyContext,
): AppliedDomain {
  if (ctx.mode === "replacement") {
    throw new Error(
      "habitatSettings.apply: mode:'replacement' in-place logic is M2's scope; M1 ships the mode:'new' INSERT path only",
    );
  }

  const now = new Date().toISOString();
  tx.insert(habitats)
    .values({
      id: prepared.habitatServerId,
      name: prepared.name,
      description: prepared.description,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return {
    domain: "habitatSettings",
    mode: "new",
    committedServerIds: [prepared.habitatServerId],
    inserted: 1,
  };
}

// ---------------------------------------------------------------------------
// The handler object (consumed by the M4 orchestrator's registry)
// ---------------------------------------------------------------------------

export const habitatSettingsHandler: DomainHandler<
  ValidatedHabitatSettings,
  PreparedHabitatSettings
> = {
  domainName: "habitatSettings",
  validate: validateHabitatSettings,
  prepare: prepareHabitatSettings,
  resolveReferences: resolveHabitatSettingsReferences,
  apply: applyHabitatSettings,
};
