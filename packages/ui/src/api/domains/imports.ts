/**
 * Import-session API client (T10C M4).
 *
 * Consumes the v3 habitat-import routes registered in
 * `packages/api/src/routes/board-export.ts`:
 *
 *   POST /habitats/import            (mode: "new")
 *   POST /habitats/:habitatId/import (mode: "replacement")
 *
 * The response shape is dispatch-on-shape at the UI boundary — the same
 * routes serve the legacy v1/v2 path (when `ORCY_CREATION_PUBLICATION_ENABLED`
 * is off) and the v3 manifest pipeline (when on). The client sends the raw
 * parsed JSON regardless of detected version; the server routes internally.
 *
 * The UI inspects the response body for `outcome` (v3) vs `habitat`/`imported`
 * (legacy) and dispatches rendering accordingly. The closed union types
 * (`PublishImportOutcomeView` + `PrepareImportOutcomeView`) live in
 * `packages/ui/src/types/index.ts` per MEMORY.md "view-model types live in
 * packages/ui/src/types/index.ts".
 *
 * A concurrent `already_publishing` response is checked by submitting the
 * same manifest again. The server's attempt identity makes that re-submit
 * idempotent; no import-attempt GET surface exists.
 */
import { request } from "../transport.js";
import type {
  ImportOutcomeView,
  PrepareImportOutcomeView,
  PublishImportOutcomeView,
} from "../../types/index.js";

export interface PublishImportInput {
  /** Target habitat for replacement; undefined for new-habitat imports. */
  habitatId?: string;
  /** The raw parsed manifest JSON (v1/v2/v3 — server detects version). */
  manifest: unknown;
}

export const importsApi = {
  /**
   * Submit a habitat-import manifest. The route is selected by `habitatId`:
   *   - `habitatId` omitted → `POST /habitats/import` (new habitat).
   *   - `habitatId` set     → `POST /habitats/:habitatId/import` (replacement).
   *
   * Returns the raw response body. The caller inspects the shape:
   *   - `{outcome: "<v3-branch>", ...}` → v3 path was taken.
   *   - `{habitat, columns, imported, warnings}` → legacy path was taken.
   *   - `{error, code, details}` → unknown version (400) or other Fastify
   *     error-handler envelope.
   *
   * Use `parsePublishImportResponse` to narrow the raw body into the
   * closed union the M4 dialog renders.
   */
  publish: (input: PublishImportInput): Promise<unknown> => {
    const path = input.habitatId
      ? `/habitats/${encodeURIComponent(input.habitatId)}/import`
      : "/habitats/import";
    return request<unknown>(path, {
      method: "POST",
      body: JSON.stringify(input.manifest),
    });
  },
};

/**
 * Type guard: response is a v3 closed-union outcome (prepare OR publish).
 * The closed union covers every branch the kernel can emit per
 * `routes/helpers/importPublicationHttp.ts` + `services/importManifest/*`.
 */
export function isV3ImportResponse(body: unknown): body is ImportOutcomeView {
  if (typeof body !== "object" || body === null) return false;
  const outcome = (body as { outcome?: unknown }).outcome;
  return (
    outcome === "published" ||
    outcome === "already_publishing" ||
    outcome === "guard_mismatch" ||
    outcome === "vetoed" ||
    outcome === "illegal_source_state" ||
    outcome === "not_found" ||
    outcome === "replayed" ||
    outcome === "rejected_preflight" ||
    outcome === "already_exists" ||
    outcome === "feature_disabled"
  );
}

/**
 * Type guard: response is the legacy v1/v2 shape
 * (`{habitat, columns, imported, warnings}`).
 */
export function isLegacyImportResponse(body: unknown): body is LegacyImportResponse {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as LegacyImportResponse;
  return (
    typeof candidate.habitat === "object" &&
    candidate.habitat !== null &&
    typeof (candidate.habitat as { id?: unknown }).id === "string" &&
    typeof candidate.columns === "object" &&
    candidate.columns !== null &&
    typeof candidate.imported === "object" &&
    candidate.imported !== null
  );
}

/**
 * Legacy v1/v2 import response shape — mirrors
 * `packages/ui/src/api/domains/habitats.ts:95-120` (`habitatsApi.import`).
 * Re-declared locally so the M4 dialog doesn't depend on a UI-local
 * `HabitatExport` for the response (the dialog only needs the success card).
 */
export interface LegacyImportResponse {
  habitat: { id: string; name?: string };
  columns: unknown[];
  imported: {
    missions: number;
    tasks: number;
    comments: number;
    templates: number;
    webhooks: number;
  };
  warnings: string[];
}

/**
 * Convenience: parse a raw response body into a typed dispatch union the
 * M4 dialog renders directly. Combines v3 outcome + legacy success-card
 * branches into one discriminated union (`kind:"v3"` vs `kind:"legacy"`).
 */
export type ParsedImportResponse =
  | { kind: "v3"; outcome: PublishImportOutcomeView | PrepareImportOutcomeView }
  | { kind: "legacy"; body: LegacyImportResponse }
  | { kind: "error"; status: number; body: { error?: string; code?: string; details?: unknown } };

export function parsePublishImportResponse(
  status: number,
  body: unknown,
): ParsedImportResponse {
  if (isV3ImportResponse(body)) {
    return { kind: "v3", outcome: body };
  }
  if (isLegacyImportResponse(body)) {
    return { kind: "legacy", body };
  }
  return {
    kind: "error",
    status,
    body:
      typeof body === "object" && body !== null
        ? (body as { error?: string; code?: string; details?: unknown })
        : {},
  };
}

/**
 * Recover a typed ParsedImportResponse from a thrown error.
 *
 * The transport's `request()` helper (packages/ui/src/api/transport.ts)
 * throws `ApiError` on any non-2xx response — but the v3 import routes
 * intentionally return 422 (rejected_preflight) + 403 (vetoed) + 409
 * (guard_mismatch, illegal_source_state) + 404 (not_found) with the closed-union outcome body
 * intact. Without this recovery, the dialog would render a generic
 * "submit error" for every M4 value-prop branch.
 *
 * The transport preserves the parsed body as `ApiError.body` (an ADDITIVE
 * field added in T10C M4); this helper extracts it + dispatches through
 * `parsePublishImportResponse`. Returns `null` when the error is not an
 * ApiError with a structured body — callers fall back to the generic error
 * path.
 *
 * Status is recovered from `ApiError.status` so the dispatch table
 * (parsePublishImportResponse) can carry it for the generic-error branch.
 */
export function parseImportApiError(
  error: unknown,
): ParsedImportResponse | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("status" in error) ||
    typeof (error as { status?: unknown }).status !== "number" ||
    !("body" in error)
  ) {
    return null;
  }
  const status = (error as { status: number }).status;
  const body = (error as { body?: unknown }).body;
  if (body === undefined) return null;
  return parsePublishImportResponse(status, body);
}
