/**
 * templates domain handler — reusable Mission layouts.
 *
 * # Validation rules (accumulate, never first-error)
 *
 *   - Per-template shape: `sourceId`, `name`, `description`, `content`,
 *     `isDefault` are well-formed.
 *   - `isDefault` uniqueness within the manifest (at most ONE default —
 *     prior art: `repositories/template.ts:165` rejects deleting a default
 *     template; the handler enforces the dual at-import rule).
 *   - `content` is a plain object with optional `columns`, `labels`,
 *     `missions` fields (template-scoped content — deep validation of the
 *     internal missions/columns happens at T10B apply time when the template
 *     is instantiated; M3 validates only the envelope shape).
 *
 * # Forbidden fields
 *
 * Per the C4 absorption table, no execution state is portable content. The
 * handler defensively re-verifies the absence of `usageCount`, `habitatId`,
 * `createdBy`, etc. (the legacy adapter M2 strips these; the handler is the
 * second-layer guard).
 *
 * # prepare
 *
 * Allocates one prospective server ID per template into the idMap.
 *
 * # resolveReferences
 *
 * Template content is template-SCOPED (the internal columns/missions are
 * anonymous — they have no cross-domain sourceIds). resolveReferences is a
 * structural no-op: the prepared payload is returned unchanged. T10B's apply
 * phase instantiates the template's internal content at write time.
 */
import type { DomainEnvelope } from "../types.js";
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
  resolutionOk,
  validationErr,
  validationOk,
} from "../domainHandler.js";
import { missionTemplates } from "../../../db/schema/habitat.js";
import type { TaskPublicationDbClient } from "../../../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Validated + prepared shapes
// ---------------------------------------------------------------------------

const FORBIDDEN_TEMPLATE_FIELDS = [
  "usageCount",
  "habitatId",
  "createdBy",
  "createdAt",
  "updatedAt",
  "id",
] as const;

export interface ValidatedTemplate {
  sourceId: string;
  name: string;
  description: string;
  content: Record<string, unknown>;
  isDefault: boolean;
}

export interface ValidatedTemplates {
  templates: ValidatedTemplate[];
}

export interface PreparedTemplate {
  sourceId: string;
  /** The prospective server-side template id (allocated in prepare). */
  templateServerId: string;
  name: string;
  description: string;
  content: Record<string, unknown>;
  isDefault: boolean;
}

export interface PreparedTemplates {
  templates: PreparedTemplate[];
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export function validateTemplates(
  envelope: DomainEnvelope<unknown>,
  _ctx: ManifestContext,
  _idMap: IdentityMap,
): DomainValidationResult<ValidatedTemplates> {
  const errors: DomainError[] = [];
  const raw = envelope.data;

  if (!Array.isArray(raw)) {
    return validationErr([
      domainError(
        "templates",
        "invalid_envelope_data",
        "templates envelope data must be an array",
        { actual: typeof raw },
      ),
    ]);
  }

  const validated: ValidatedTemplate[] = [];
  let defaultCount = 0;

  raw.forEach((entry, i) => {
    const fieldPathBase: readonly (string | number)[] = ["templates", i];
    const errs: DomainError[] = [];

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        domainError(
          "templates",
          "invalid_template_shape",
          `templates[${i}] must be a plain object`,
          {
            actual: entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry,
            fieldPath: fieldPathBase,
          },
        ),
      );
      return;
    }

    const e = entry as Record<string, unknown>;

    if (typeof e.sourceId !== "string" || e.sourceId.length === 0) {
      errs.push(
        domainError(
          "templates",
          "invalid_source_id",
          `templates[${i}].sourceId must be a non-empty string`,
          { actual: typeof e.sourceId, fieldPath: [...fieldPathBase, "sourceId"] },
        ),
      );
    }

    if (typeof e.name !== "string" || e.name.length === 0) {
      errs.push(
        domainError(
          "templates",
          "invalid_name",
          `templates[${i}].name must be a non-empty string`,
          {
            actual: typeof e.name,
            fieldPath: [...fieldPathBase, "name"],
          },
        ),
      );
    }

    if (typeof e.description !== "string") {
      errs.push(
        domainError(
          "templates",
          "invalid_description",
          `templates[${i}].description must be a string`,
          { actual: typeof e.description, fieldPath: [...fieldPathBase, "description"] },
        ),
      );
    }

    if (e.content === null || typeof e.content !== "object" || Array.isArray(e.content)) {
      errs.push(
        domainError(
          "templates",
          "invalid_content",
          `templates[${i}].content must be a plain JSON object`,
          {
            actual:
              e.content === null ? "null" : Array.isArray(e.content) ? "array" : typeof e.content,
            fieldPath: [...fieldPathBase, "content"],
          },
        ),
      );
    }

    if (typeof e.isDefault !== "boolean") {
      errs.push(
        domainError(
          "templates",
          "invalid_is_default",
          `templates[${i}].isDefault must be a boolean`,
          { actual: typeof e.isDefault, fieldPath: [...fieldPathBase, "isDefault"] },
        ),
      );
    }

    // Forbidden-field absence (C4 defensive re-verification)
    for (const forbidden of FORBIDDEN_TEMPLATE_FIELDS) {
      if (e[forbidden] !== undefined) {
        errs.push(
          domainError(
            "templates",
            "forbidden_field_present",
            `forbidden field '${forbidden}' must not appear on template (C4 absorption: the adapter should have stripped it)`,
            { fieldPath: [...fieldPathBase, forbidden] },
          ),
        );
      }
    }

    if (errs.length > 0) {
      errors.push(...errs);
      return;
    }

    if (e.isDefault === true) defaultCount++;

    validated.push({
      sourceId: e.sourceId as string,
      name: e.name as string,
      description: e.description as string,
      content: e.content as Record<string, unknown>,
      isDefault: e.isDefault as boolean,
    });
  });

  // isDefault uniqueness: at most one default template per manifest.
  if (defaultCount > 1) {
    errors.push(
      domainError(
        "templates",
        "multiple_default_templates",
        `at most one template may carry isDefault:true; found ${defaultCount}`,
        { actual: defaultCount, expected: "0 or 1" },
      ),
    );
  }

  if (errors.length > 0) return validationErr(errors);
  return validationOk({ templates: validated });
}

// ---------------------------------------------------------------------------
// Prepare (PURE — no DB writes)
// ---------------------------------------------------------------------------

export function prepareTemplates(
  validated: ValidatedTemplates,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): PreparedTemplates {
  const templates: PreparedTemplate[] = validated.templates.map((t) => {
    const templateServerId = allocateServerId(idMap, t.sourceId);
    return {
      sourceId: t.sourceId,
      templateServerId,
      name: t.name,
      description: t.description,
      content: t.content,
      isDefault: t.isDefault,
    };
  });
  return { templates };
}

// ---------------------------------------------------------------------------
// Resolve references (PURE — template content is template-scoped; no-op)
// ---------------------------------------------------------------------------

/**
 * Resolves template references. Template content is template-SCOPED — the
 * internal columns/missions are anonymous (no cross-domain sourceIds to
 * rewrite). The phase is a structural no-op for interface uniformity.
 */
export function resolveTemplatesReferences(
  prepared: PreparedTemplates,
  _ctx: ManifestContext,
  _idMap: IdentityMap,
): ReferenceResolution<PreparedTemplates> {
  return resolutionOk(prepared);
}

// ---------------------------------------------------------------------------
// Apply (T10B M1 — caller-owned tx; `mode:"new"` INSERT path with best-effort
// v3 → v0.31-schema mapping)
// ---------------------------------------------------------------------------

/**
 * Writes the template rows for `mode:"new"` imports. Each prepared
 * {@link PreparedTemplate} becomes one INSERT into `mission_templates` on
 * the caller-owned tx client.
 *
 * # v3 ↔ v0.31 schema adaptation (drift 1)
 *
 * The `mission_templates` table is v0.31-shaped: it carries
 * `titlePattern` / `descriptionPattern` (legacy template-string fields)
 * but no slot for the v3 `TemplateContentPortable`'s full content graph.
 * Per drift 1, the v3 type carries Task-level template fields that have no
 * schema column (and no v3 slot in the M1 type). M1 therefore stores:
 *   - `prepared.name` → `name`
 *   - `prepared.description` → `descriptionPattern` (best-effort — the
 *     table has no free-form description, so the description lands as the
 *     pattern. The `titlePattern` defaults to `name`.)
 *   - `prepared.content.labels` → `labels` JSON (when present)
 *   - `prepared.content.missions` (the synthesized single-mission per the
 *     drift 1 adapter synthesis) is DROPPED — `tasksTemplate` stays empty
 *     (`[]`) because the M1 type has no task-level template slots. The
 *     import succeeds for the structural data; the missing-task-level-fields
 *     surfaces via the M2 adapter's per-template warnings.
 *   - `prepared.isDefault` → `isDefault` (the M3 validate-phase
 *     uniqueness rule already enforced at most one default per manifest)
 *
 * # Caller-owned tx (load-bearing)
 *
 * Receives a {@link TaskPublicationDbClient} from the orchestrator.
 * NEVER calls `getDb()`. A throw at any handler aborts the orchestrator's
 * tx; the whole aggregate rolls back.
 */
export function applyTemplates(
  tx: TaskPublicationDbClient,
  prepared: PreparedTemplates,
  ctx: ApplyContext,
): AppliedDomain {
  if (ctx.mode === "replacement") {
    throw new Error(
      "templates.apply: mode:'replacement' in-place logic is M2's scope; M1 ships the mode:'new' INSERT path only",
    );
  }

  const now = new Date().toISOString();
  const committedServerIds: string[] = [];
  for (const t of prepared.templates) {
    const labels = Array.isArray(t.content?.["labels"])
      ? (t.content["labels"] as unknown[]).filter((l): l is string => typeof l === "string")
      : [];

    tx.insert(missionTemplates)
      .values({
        id: t.templateServerId,
        habitatId: ctx.targetHabitatId,
        name: t.name,
        // titlePattern defaults to name (the table's required field; the v3
        // portable has no `title` slot at the template level, so the
        // template's own name becomes the title pattern).
        titlePattern: t.name,
        descriptionPattern: t.description,
        // Defaulted: priority is not in v3 TemplatePortable; the schema's
        // column default ('medium') applies via omission.
        labels,
        // Defaulted: requiredDomain / requiredCapabilities not in v3 portable.
        isDefault: t.isDefault,
        // usageCount defaults to 0 (schema).
        createdBy: "import",
        createdAt: now,
        // tasksTemplate defaults to [] (schema). The synthesized
        // TemplateContentPortable.missions (drift 1) has no native column.
        // workflowTemplate defaults to null (schema).
      })
      .run();
    committedServerIds.push(t.templateServerId);
  }

  return {
    domain: "templates",
    mode: "new",
    committedServerIds,
    inserted: committedServerIds.length,
  };
}

// ---------------------------------------------------------------------------
// The handler object
// ---------------------------------------------------------------------------

export const templatesHandler: DomainHandler<ValidatedTemplates, PreparedTemplates> = {
  domainName: "templates",
  validate: validateTemplates,
  prepare: prepareTemplates,
  resolveReferences: resolveTemplatesReferences,
  apply: applyTemplates,
};
