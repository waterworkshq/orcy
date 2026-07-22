import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as habitatService from "../services/habitatService.js";
import { exportQuerySchema, importHabitatSchema } from "../models/schemas.js";
import { agentOrHumanAuth, humanAuth } from "../middleware/auth.js";
import { requireHabitatAccess } from "../middleware/team.js";
import * as anomalyService from "../services/anomalyService.js";
import { redactSensitiveHeaders } from "../config/integrationSecurity.js";
import { notFound, badRequest } from "../errors.js";
import { getDb } from "../db/index.js";
import {
  computeManifestDigest,
  prepareImport,
  runPreflightPipeline,
  type PreparedImport,
} from "../services/importManifest/preflightImport.js";
import { publishImportAggregateWithClient } from "../services/importManifest/importPublication.js";
import type { HabitatImportManifest } from "../services/importManifest/types.js";
import {
  prepareImportOutcomeToHttpResponse,
  publishImportOutcomeToHttpResponse,
} from "./helpers/importPublicationHttp.js";
import type { AuditActorRef } from "@orcy/shared";

const habitatIdParamsSchema = z.object({ habitatId: z.string() });

// Permissive body schema for the two import routes. Accepts BOTH:
//   - v1/v2 inputs via the legacy `importHabitatSchema` (which carries the
//     silent `z.preprocess` v1→v2 normalization),
//   - ANY other input shape (v3 manifests, version:4, etc.) via `z.any()`.
// Strict validation and version dispatch run inside `handleManifestImportRequest`.
const importRouteBodySchema = z.union([importHabitatSchema, z.any()]);

export async function habitatExportRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /habitats/:habitatId/export - Export board data. Auth: humanAuth. Returns filtered board export */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/export",
    {
      schema: { params: habitatIdParamsSchema, querystring: exportQuerySchema },
      preHandler: humanAuth,
    },
    async (request, _reply) => {
      const result = habitatService.exportHabitat(request.params.habitatId);
      if (!result) {
        throw notFound("Habitat not found");
      }

      const parsed = request.query;
      const include = parsed.include?.split(",") ?? [
        "columns",
        "missions",
        "comments",
        "templates",
      ];

      const webhooks = include.includes("webhooks")
        ? result.habitat.webhooks.map((w) => {
            const { headers, url, ...rest } = w;
            return {
              ...rest,
              url: url.replace(/\/\/[^@]+@/, "//***@"),
              headers: redactSensitiveHeaders(headers),
            };
          })
        : [];

      const filtered = {
        version: result.version,
        exportedAt: result.exportedAt,
        habitat: {
          name: result.habitat.name,
          description: result.habitat.description,
          columns: include.includes("columns") ? result.habitat.columns : [],
          missions: include.includes("missions") ? result.habitat.missions : [],
          comments: include.includes("comments") ? result.habitat.comments : [],
          templates: include.includes("templates") ? result.habitat.templates : [],
          webhooks,
        },
      };

      return filtered;
    },
  );

  /** POST /boards/import - Import a new board. Auth: humanAuth. Returns { board, columns, imported, warnings } */
  fastify
    .withTypeProvider<ZodTypeProvider>()
    .post(
      "/habitats/import",
      { schema: { body: importRouteBodySchema }, preHandler: humanAuth },
      async (request, reply) => {
        await handleManifestImportRequest(request, reply, {
          targetHabitatId: null,
          routeDeclaredMode: "new",
        });
      },
    );

  /** POST /habitats/:habitatId/import - Import into existing board. Auth: humanAuth + requireHabitatAccess. Returns { board, columns, imported, warnings } */
  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/import",
    {
      schema: { params: habitatIdParamsSchema, body: importRouteBodySchema },
      preHandler: [humanAuth, requireHabitatAccess],
    },
    async (request, reply) => {
      const habitatResult = habitatService.getHabitat(request.params.habitatId);
      if (!habitatResult) {
        throw notFound("Habitat not found");
      }

      await handleManifestImportRequest(request, reply, {
        targetHabitatId: request.params.habitatId,
        routeDeclaredMode: "replacement",
      });
    },
  );

  /** GET /habitats/:habitatId/anomalies - Detect and return current anomalies for a board. Auth: agentOrHumanAuth + board access. Returns { anomalies } */
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/anomalies",
    {
      schema: { params: habitatIdParamsSchema },
      preHandler: [agentOrHumanAuth, requireHabitatAccess],
    },
    async (request, _reply) => {
      const result = habitatService.getHabitat(request.params.habitatId);
      if (!result) {
        throw notFound("Habitat not found");
      }
      const anomalies = anomalyService.detectAnomalies(request.params.habitatId);
      return { anomalies };
    },
  );
}

// ---------------------------------------------------------------------------
// Manifest-v3 import dispatch through the publication kernel.
//
// Invoked from both `/habitats/import` (mode:"new") and
// `/habitats/:habitatId/import` (mode:"replacement") when the cutover flag
// is ON. Composes `prepareImport` + `publishImportAggregateWithClient` and
// maps the closed outcome unions to HTTP via the shared helper at
// `routes/helpers/importPublicationHttp.ts`. Mirrors the precedent at
// `routes/taskClonePublication.ts` (the dispatch + actor-derivation pattern)
// + `routes/helpers/taskPublicationHttp.ts` (the mapper discipline).
//
// v1/v2 inputs are routed through `prepareImport` directly — its step 2-3
// (`detectAndAdaptInput`) runs the legacy adapter internally. The route
// does NOT call `adaptUnknown` separately. This is a divergence from the
// T10C grounding's pseudocode (which over-decomposed the dispatch into
// separate v3Pipeline / v3PipelineViaLegacyAdapter paths); the kernel's
// actual interface is `rawManifest: unknown` + internal version detection.
// ---------------------------------------------------------------------------

/**
 * Derives the {@link AuditActorRef} from the authenticated request's auth
 * context. `humanAuth` (the only preHandler on the import routes) sets
 * `request.user`; `request.agent` is set by `agentAuth` / `agentOrHumanAuth`
 * (not used here, but handled defensively per the clone-publication
 * precedent at `routes/taskClonePublication.ts:225-230`).
 */
function deriveImportActor(request: FastifyRequest): AuditActorRef {
  if (request.agent) {
    return { type: "agent", id: request.agent.id };
  }
  if (request.user) {
    return { type: "human", id: request.user.id };
  }
  // humanAuth always sets request.user — defensive fallback.
  throw badRequest("Authenticated actor not found on request");
}

/**
 * The shared dispatch body for both import routes (flag ON path). Resolves
 * the manifest version + the route's declared mode + the target habitat,
 * constructs the `PrepareImportInput`, runs the kernel, and maps the
 * outcome to HTTP.
 *
 * `targetHabitatId` is `null` for `mode:"new"` (the new-habitat route);
 * the live habitat id for `mode:"replacement"` (the replacement route).
 *
 * `routeDeclaredMode` is the mode the route's URL declares (`/habitats/
 * import` → "new"; `/habitats/:habitatId/import` → "replacement"). For v3
 * inputs the manifest's declared mode is authoritative — the route rejects
 * a mismatch with 400. For v1/v2 inputs (which have no mode field) the
 * route's declared mode overrides the adapter's default.
 */
async function handleManifestImportRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    targetHabitatId: string | null;
    routeDeclaredMode: "new" | "replacement";
  },
): Promise<void> {
  const { targetHabitatId, routeDeclaredMode } = options;

  // Version dispatch. v3 + v1 + v2 all flow through `prepareImport` (which
  // detects + adapts internally); anything else is a 400.
  const body = request.body as { version?: unknown; mode?: unknown } | null;
  const version = body?.version;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw badRequest(
      `Unsupported export version: ${JSON.stringify(version)}. Only versions 1, 2, and 3 are supported.`,
    );
  }

  // Mode reconciliation. For v3, the manifest's declared mode is
  // authoritative — reject a mismatch. For v1/v2 (no mode field), the
  // route supplies the override so `prepareImport`'s `input.mode ??`
  // resolution picks up the route's intent.
  let modeOverride: "new" | "replacement" | undefined;
  if (version === 3) {
    const manifestMode = body?.mode;
    if (manifestMode !== routeDeclaredMode) {
      throw badRequest(
        `Manifest mode ${JSON.stringify(manifestMode)} does not match the route's declared mode ${JSON.stringify(routeDeclaredMode)}. Use the ${routeDeclaredMode === "new" ? "/habitats/import" : "/habitats/:habitatId/import"} route for ${routeDeclaredMode} imports.`,
      );
    }
    // Manifest is authoritative — no override.
    modeOverride = undefined;
  } else {
    // v1/v2 legacy input — adapter defaults mode to "new"; the route
    // overrides to the path's declared mode so replacement imports reach
    // the replacement pipeline.
    modeOverride = routeDeclaredMode;
  }

  // Authority construction — server-derived from the authenticated caller
  // (untrusted body fields cannot assert privileged identities). The
  // `auditSource` enum is the ORIGIN CHANNEL — REST routes always carry
  // `"rest_api"` (the UI/API distinction surfaces in `actorType`, not the
  // auditSource enum — mirrors the clone-publication precedent).
  const actor = deriveImportActor(request);
  const auditSource = "rest_api" as const;

  // Kernel composition: prepare (PURE 6-step pipeline) → publish (atomic
  // BEGIN IMMEDIATE tx). The route forwards the outcomes to HTTP verbatim.
  const prepareResult = prepareImport({
    rawManifest: request.body,
    habitatId: targetHabitatId,
    mode: modeOverride,
    actor,
    auditSource,
  });

  if (prepareResult.outcome === "prepared") {
    const publishResult = publishImportAggregateWithClient(getDb(), {
      prepared: prepareResult.prepared,
    });
    const { statusCode, body: publishBody } = publishImportOutcomeToHttpResponse(publishResult);
    reply.code(statusCode).send(publishBody);
    return;
  }

  if (
    version === 3 &&
    prepareResult.outcome === "already_exists" &&
    prepareResult.attempt.state === "publishing" &&
    prepareResult.attempt.attemptId !== null &&
    prepareResult.attempt.leaseExpiresAt !== null &&
    prepareResult.attempt.leaseExpiresAt < new Date().toISOString()
  ) {
    const manifest = request.body as HabitatImportManifest;
    const manifestDigest = computeManifestDigest(manifest);

    // A manifest id is the import idempotency key. Only the exact manifest
    // that reserved this attempt may reclaim it; a different payload using
    // the same id receives the existing-attempt response below.
    if (manifestDigest === prepareResult.attempt.manifestDigest) {
      const pipelineResult = runPreflightPipeline(
        manifest,
        prepareResult.attempt.habitatId || null,
        prepareResult.attempt.mode,
        actor,
        auditSource,
        prepareResult.attempt.attemptId,
        [],
        false,
      );

      if (pipelineResult.outcome === "prepared") {
        const prepared: PreparedImport = {
          manifest: pipelineResult.manifest,
          manifestDigest,
          identityMap: pipelineResult.identityMap,
          preparedDomains: pipelineResult.preparedDomains,
          guard: pipelineResult.guard,
          governanceDecisions: pipelineResult.governanceDecisions,
          authority: {
            caller: actor,
            auditSource,
            governingPolicy:
              prepareResult.attempt.mode === "new" ? "installation" : "persisted_habitat",
          },
          prefilledAttemptId: prepareResult.attempt.attemptId,
          existingHabitatSnapshot: pipelineResult.existingHabitatSnapshot,
        };
        const publishResult = publishImportAggregateWithClient(getDb(), { prepared });
        const { statusCode, body: publishBody } = publishImportOutcomeToHttpResponse(publishResult);
        reply.code(statusCode).send(publishBody);
        return;
      }
    }
  }

  const { statusCode, body: prepareBody } = prepareImportOutcomeToHttpResponse(prepareResult);
  reply.code(statusCode).send(prepareBody);
}
