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
// The handler object
// ---------------------------------------------------------------------------

export const templatesHandler: DomainHandler<ValidatedTemplates, PreparedTemplates> = {
  domainName: "templates",
  validate: validateTemplates,
  prepare: prepareTemplates,
  resolveReferences: resolveTemplatesReferences,
};
