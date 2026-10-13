/**
 * Local role administration routes (administration ticket).
 *
 * The 13 served governance commands from the binding's exact command matrix.
 * All are `authPolicy: "human"`; every mutating body carries `scopeIncarnation`
 * and `expectedScopeVersion` (+ object expectations) which the service layer
 * checks inside its single IMMEDIATE reservation. Error contract: 404 before
 * governor 403 `AUTHORIZATION_DENIED`; stale expectations 409 with
 * `GOVERNANCE_VERSION_CONFLICT` / `ROLE_REVISION_CONFLICT` /
 * `ROLE_ASSIGNMENT_VERSION_CONFLICT`; validation 400; creation 201; object
 * mutation 200; revoke/owner-clear 204.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import { badRequest } from "../errors.js";
import {
  clearHabitatOwner,
  createAssignment,
  createCustomDefinition,
  getPermissionsCatalogue,
  getRoleDefinition,
  listRoleAssignments,
  listRoles,
  mintRevision,
  repinAssignment,
  retireDefinition,
  revokeAssignment,
  setHabitatOwner,
} from "../services/localRoleAdministration.js";
import type { GovernanceScopeKind } from "../services/localAuthorization.js";

const scopeQuerySchema = z.object({
  scopeKind: z.enum(["team", "habitat", "mission", "task"]),
  scopeId: z.string().min(1),
});

const namespaceQuerySchema = z.object({
  scopeKind: z.enum(["team", "habitat"]),
  scopeId: z.string().min(1),
});

const permissionsSchema = z
  .array(z.enum(["review.configure", "review.assign"]))
  .min(1);

const scopeExpectationSchema = z.object({
  scopeIncarnation: z.number().int().min(1),
  expectedScopeVersion: z.number().int().min(1),
});

const createDefinitionSchema = scopeExpectationSchema.extend({
  name: z.string().min(1).max(200),
  permissions: permissionsSchema,
});

const mintRevisionSchema = scopeExpectationSchema.extend({
  permissions: permissionsSchema,
  expectedLatestRevision: z.number().int().min(1),
});

const retireDefinitionSchema = scopeExpectationSchema.extend({
  reason: z.string().min(1).max(2000),
  expectedLatestRevision: z.number().int().min(1),
});

const createAssignmentSchema = scopeExpectationSchema.extend({
  principalType: z.enum(["human", "agent"]),
  principalId: z.string().min(1),
  revisionId: z.string().min(1),
  scopeKind: z.enum(["team", "habitat", "mission", "task"]),
  scopeId: z.string().min(1),
  // Caller-side guard mirroring the service's `normalizeExpiry` contract:
  // an ISO date-time with a MANDATORY timezone. Valid offset forms are NOT
  // rejected here — they are canonicalized to UTC by the service before
  // storage (the evaluator requires canonical UTC on stored strings).
  expiresAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, {
      message: "expiresAt must be an ISO instant with a timezone",
    })
    .nullable()
    .optional(),
});

const repinAssignmentSchema = scopeExpectationSchema.extend({
  revisionId: z.string().min(1),
  expectedAssignmentVersion: z.number().int().min(1),
});

const revokeAssignmentSchema = scopeExpectationSchema.extend({
  reason: z.string().min(1).max(2000),
  expectedAssignmentVersion: z.number().int().min(1),
});

const setOwnerSchema = scopeExpectationSchema.extend({
  ownerUserId: z.string().min(1),
  reason: z.string().min(1).max(2000),
});

const clearOwnerSchema = scopeExpectationSchema.extend({
  reason: z.string().min(1).max(2000),
});

function requireUser(request: FastifyRequest): string {
  if (!request.user?.id) {
    // authPolicy: "human" already guarantees a human JWT; this is a cast guard.
    throw badRequest("Authenticated human required");
  }
  return request.user.id;
}

function parseOr400<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Validation failed", parsed.error.flatten());
  }
  return parsed.data;
}

export async function roleAdminRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  // 1. GET /permissions — fixed catalogue, any authenticated human.
  fastify.get(
    "/permissions",
    { config: { authPolicy: "human" } },
    async () => getPermissionsCatalogue(),
  );

  // 2. GET /roles — namespace definitions + ledger state (team/habitat).
  fastify.get(
    "/roles",
    { config: { authPolicy: "human" } },
    async (request) => {
      const query = parseOr400(namespaceQuerySchema, request.query);
      return listRoles(requireUser(request), query.scopeKind, query.scopeId);
    },
  );

  // 3. GET /role-definitions/:id — definition, revisions, namespace state.
  fastify.get<{ Params: { id: string } }>(
    "/role-definitions/:id",
    { config: { authPolicy: "human" } },
    async (request) => getRoleDefinition(requireUser(request), request.params.id),
  );

  // 4. GET /role-assignments — exact-scope assignments (retained included).
  fastify.get(
    "/role-assignments",
    { config: { authPolicy: "human" } },
    async (request) => {
      const query = parseOr400(scopeQuerySchema, request.query);
      return listRoleAssignments(
        requireUser(request),
        query.scopeKind as GovernanceScopeKind,
        query.scopeId,
      );
    },
  );

  // 5. POST /teams/:id/role-definitions — 201.
  fastify.post<{ Params: { id: string } }>(
    "/teams/:id/role-definitions",
    { config: { authPolicy: "human" } },
    async (request, reply) => {
      const body = parseOr400(createDefinitionSchema, request.body);
      const result = createCustomDefinition({
        actorUserId: requireUser(request),
        scopeKind: "team",
        scopeId: request.params.id,
        scopeIncarnation: body.scopeIncarnation,
        expectedScopeVersion: body.expectedScopeVersion,
        name: body.name,
        permissions: body.permissions,
      });
      reply.code(201).send(result);
    },
  );

  // 6. POST /habitats/:id/role-definitions — 201.
  fastify.post<{ Params: { id: string } }>(
    "/habitats/:id/role-definitions",
    { config: { authPolicy: "human" } },
    async (request, reply) => {
      const body = parseOr400(createDefinitionSchema, request.body);
      const result = createCustomDefinition({
        actorUserId: requireUser(request),
        scopeKind: "habitat",
        scopeId: request.params.id,
        scopeIncarnation: body.scopeIncarnation,
        expectedScopeVersion: body.expectedScopeVersion,
        name: body.name,
        permissions: body.permissions,
      });
      reply.code(201).send(result);
    },
  );

  // 7. POST /role-definitions/:id/revisions — 201.
  fastify.post<{ Params: { id: string } }>(
    "/role-definitions/:id/revisions",
    { config: { authPolicy: "human" } },
    async (request, reply) => {
      const body = parseOr400(mintRevisionSchema, request.body);
      const result = mintRevision({
        actorUserId: requireUser(request),
        definitionId: request.params.id,
        permissions: body.permissions,
        scopeIncarnation: body.scopeIncarnation,
        expectedScopeVersion: body.expectedScopeVersion,
        expectedLatestRevision: body.expectedLatestRevision,
      });
      reply.code(201).send(result);
    },
  );

  // 8. POST /role-definitions/:id/retire — 200.
  fastify.post<{ Params: { id: string } }>(
    "/role-definitions/:id/retire",
    { config: { authPolicy: "human" } },
    async (request) => {
      const body = parseOr400(retireDefinitionSchema, request.body);
      return retireDefinition({
        actorUserId: requireUser(request),
        definitionId: request.params.id,
        reason: body.reason,
        scopeIncarnation: body.scopeIncarnation,
        expectedScopeVersion: body.expectedScopeVersion,
        expectedLatestRevision: body.expectedLatestRevision,
      });
    },
  );

  // 9. POST /role-assignments — 201.
  fastify.post(
    "/role-assignments",
    { config: { authPolicy: "human" } },
    async (request, reply) => {
      const body = parseOr400(createAssignmentSchema, request.body);
      const result = createAssignment({
        actorUserId: requireUser(request),
        principalType: body.principalType,
        principalId: body.principalId,
        revisionId: body.revisionId,
        scopeKind: body.scopeKind as GovernanceScopeKind,
        scopeId: body.scopeId,
        scopeIncarnation: body.scopeIncarnation,
        expectedScopeVersion: body.expectedScopeVersion,
        expiresAt: body.expiresAt,
      });
      reply.code(201).send({ assignment: result });
    },
  );

  // 10. POST /role-assignments/:id/revisions — 200.
  fastify.post<{ Params: { id: string } }>(
    "/role-assignments/:id/revisions",
    { config: { authPolicy: "human" } },
    async (request) => {
      const body = parseOr400(repinAssignmentSchema, request.body);
      return {
        assignment: repinAssignment({
          actorUserId: requireUser(request),
          assignmentId: request.params.id,
          revisionId: body.revisionId,
          scopeIncarnation: body.scopeIncarnation,
          expectedScopeVersion: body.expectedScopeVersion,
          expectedAssignmentVersion: body.expectedAssignmentVersion,
        }),
      };
    },
  );

  // 11. DELETE /role-assignments/:id — 204.
  fastify.delete<{ Params: { id: string } }>(
    "/role-assignments/:id",
    { config: { authPolicy: "human" } },
    async (request, reply) => {
      const body = parseOr400(revokeAssignmentSchema, request.body);
      revokeAssignment({
        actorUserId: requireUser(request),
        assignmentId: request.params.id,
        reason: body.reason,
        scopeIncarnation: body.scopeIncarnation,
        expectedScopeVersion: body.expectedScopeVersion,
        expectedAssignmentVersion: body.expectedAssignmentVersion,
      });
      reply.code(204).send();
    },
  );

  // 12. PUT /habitats/:id/owner — 200.
  fastify.put<{ Params: { id: string } }>(
    "/habitats/:id/owner",
    { config: { authPolicy: "human" } },
    async (request) => {
      const body = parseOr400(setOwnerSchema, request.body);
      return setHabitatOwner({
        actorUserId: requireUser(request),
        habitatId: request.params.id,
        ownerUserId: body.ownerUserId,
        reason: body.reason,
        scopeIncarnation: body.scopeIncarnation,
        expectedScopeVersion: body.expectedScopeVersion,
      });
    },
  );

  // 13. DELETE /habitats/:id/owner — 204.
  fastify.delete<{ Params: { id: string } }>(
    "/habitats/:id/owner",
    { config: { authPolicy: "human" } },
    async (request, reply) => {
      const body = parseOr400(clearOwnerSchema, request.body);
      clearHabitatOwner({
        actorUserId: requireUser(request),
        habitatId: request.params.id,
        reason: body.reason,
        scopeIncarnation: body.scopeIncarnation,
        expectedScopeVersion: body.expectedScopeVersion,
      });
      reply.code(204).send();
    },
  );
}
