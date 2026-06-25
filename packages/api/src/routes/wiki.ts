import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { WIKI_LINK_TARGET_TYPES } from "@orcy/shared";
import * as wikiService from "../services/wikiService.js";
import * as wikiPageVersionRepo from "../repositories/wikiPageVersion.js";
import * as habitatRepo from "../repositories/board.js";
import * as augmentation from "../services/wikiAugmentationService.js";
import * as scheduler from "../services/wikiSchedulerService.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { badRequest, notFound } from "../errors.js";

const createPageSchema = z.object({
  title: z.string().min(1),
  content: z.string(),
  parentId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["draft", "published"]).optional(),
});

const updatePageMetadataSchema = z.object({
  parentId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["draft", "published"]).optional(),
});

const deletePageSchema = z.object({
  stayGone: z.boolean().optional(),
  reason: z.string().optional(),
});

const saveVersionSchema = z.object({
  title: z.string().min(1),
  content: z.string(),
  editSummary: z.string().optional(),
});

const addLinkSchema = z.object({
  targetType: z.enum(WIKI_LINK_TARGET_TYPES),
  targetId: z.string().min(1),
  note: z.string().optional(),
});

const noUpdateNeededSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().optional(),
});

const listPagesQuerySchema = z.object({
  parentId: z.string().nullable().optional(),
  tag: z.string().optional(),
  status: z.enum(["draft", "published"]).optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const paramsWithHabitat = z.object({ habitatId: z.string() });
const paramsWithHabitatAndPage = z.object({ habitatId: z.string(), pageId: z.string() });
const paramsWithPageLink = z.object({
  habitatId: z.string(),
  pageId: z.string(),
  linkId: z.string(),
});
const paramsWithVersion = z.object({
  habitatId: z.string(),
  pageId: z.string(),
  n: z.coerce.number().int().min(1),
});

function requireHabitat(habitatId: string): void {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) throw notFound("Habitat not found");
}

/**
 * Wiki routes — pages, versions, links, search, and coverage markers. All routes
 * require an authenticated orcy (human or agent) per ADR-0009 (pure democracy). Mounted
 * under `/habitats/:habitatId/wiki/...` inside `registerApiRoutes`.
 */
export async function wikiRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Params: z.infer<typeof paramsWithHabitat>;
    Querystring: z.infer<typeof listPagesQuerySchema>;
  }>(
    "/habitats/:habitatId/wiki/pages",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitat>;
        Querystring: z.infer<typeof listPagesQuerySchema>;
      }>,
      _reply: FastifyReply,
    ) => {
      requireHabitat(request.params.habitatId);

      const parsed = listPagesQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }

      const pages = wikiService.listPages(request.params.habitatId, {
        ...(parsed.data.parentId !== undefined ? { parentId: parsed.data.parentId } : {}),
        ...(parsed.data.tag !== undefined ? { tag: parsed.data.tag } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      });
      return { pages };
    },
  );

  fastify.post<{
    Params: z.infer<typeof paramsWithHabitat>;
    Body: z.infer<typeof createPageSchema>;
  }>(
    "/habitats/:habitatId/wiki/pages",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitat>;
        Body: z.infer<typeof createPageSchema>;
      }>,
      reply: FastifyReply,
    ) => {
      requireHabitat(request.params.habitatId);

      const parsed = createPageSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }

      const createdBy = request.agent?.id ?? request.user!.id;
      const page = wikiService.createPage(request.params.habitatId, parsed.data, createdBy);
      reply.code(201).send({ page });
    },
  );

  fastify.get<{ Params: z.infer<typeof paramsWithHabitatAndPage> }>(
    "/habitats/:habitatId/wiki/pages/:pageId",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{ Params: z.infer<typeof paramsWithHabitatAndPage> }>,
      _reply,
    ) => {
      const page = wikiService.getPage(request.params.pageId);
      return { page };
    },
  );

  fastify.patch<{
    Params: z.infer<typeof paramsWithHabitatAndPage>;
    Body: z.infer<typeof updatePageMetadataSchema>;
  }>(
    "/habitats/:habitatId/wiki/pages/:pageId",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitatAndPage>;
        Body: z.infer<typeof updatePageMetadataSchema>;
      }>,
      _reply,
    ) => {
      const parsed = updatePageMetadataSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }

      const editedBy = request.agent?.id ?? request.user!.id;
      const page = wikiService.updatePageMetadata(request.params.pageId, parsed.data, editedBy);
      return { page };
    },
  );

  fastify.delete<{
    Params: z.infer<typeof paramsWithHabitatAndPage>;
    Body: z.infer<typeof deletePageSchema>;
  }>(
    "/habitats/:habitatId/wiki/pages/:pageId",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitatAndPage>;
        Body: z.infer<typeof deletePageSchema>;
      }>,
      reply,
    ) => {
      const parsed = deletePageSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }

      const deletedBy = request.agent?.id ?? request.user!.id;
      wikiService.deletePage(request.params.pageId, parsed.data, deletedBy);
      reply.code(200).send({ success: true });
    },
  );

  fastify.get<{ Params: z.infer<typeof paramsWithHabitatAndPage> }>(
    "/habitats/:habitatId/wiki/pages/:pageId/versions",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{ Params: z.infer<typeof paramsWithHabitatAndPage> }>,
      _reply,
    ) => {
      const versions = wikiPageVersionRepo.listByPage(request.params.pageId);
      return { versions };
    },
  );

  fastify.get<{ Params: z.infer<typeof paramsWithVersion> }>(
    "/habitats/:habitatId/wiki/pages/:pageId/versions/:n",
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: z.infer<typeof paramsWithVersion> }>, _reply) => {
      const version = wikiPageVersionRepo.getByPageAndNumber(
        request.params.pageId,
        request.params.n,
      );
      if (!version)
        throw notFound(`Wiki page version not found: ${request.params.pageId}@${request.params.n}`);
      return { version };
    },
  );

  fastify.post<{
    Params: z.infer<typeof paramsWithHabitatAndPage>;
    Body: z.infer<typeof saveVersionSchema>;
  }>(
    "/habitats/:habitatId/wiki/pages/:pageId/versions",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitatAndPage>;
        Body: z.infer<typeof saveVersionSchema>;
      }>,
      _reply,
    ) => {
      const parsed = saveVersionSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }

      const editedBy = request.agent?.id ?? request.user!.id;
      const page = wikiService.saveVersion(request.params.pageId, parsed.data, editedBy);
      return { page };
    },
  );

  fastify.post<{ Params: z.infer<typeof paramsWithVersion> }>(
    "/habitats/:habitatId/wiki/pages/:pageId/versions/:n/restore",
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: z.infer<typeof paramsWithVersion> }>, _reply) => {
      const editedBy = request.agent?.id ?? request.user!.id;
      const page = wikiService.restoreVersion(request.params.pageId, request.params.n, editedBy);
      return { page };
    },
  );

  fastify.get<{ Params: z.infer<typeof paramsWithHabitatAndPage> }>(
    "/habitats/:habitatId/wiki/pages/:pageId/links",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{ Params: z.infer<typeof paramsWithHabitatAndPage> }>,
      _reply,
    ) => {
      const links = wikiService.listLinks(request.params.pageId);
      return { links };
    },
  );

  fastify.post<{
    Params: z.infer<typeof paramsWithHabitatAndPage>;
    Body: z.infer<typeof addLinkSchema>;
  }>(
    "/habitats/:habitatId/wiki/pages/:pageId/links",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitatAndPage>;
        Body: z.infer<typeof addLinkSchema>;
      }>,
      reply,
    ) => {
      const parsed = addLinkSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }

      const createdBy = request.agent?.id ?? request.user!.id;
      const link = wikiService.addLink(request.params.pageId, parsed.data, createdBy);
      reply.code(201).send({ link });
    },
  );

  fastify.delete<{ Params: z.infer<typeof paramsWithPageLink> }>(
    "/habitats/:habitatId/wiki/pages/:pageId/links/:linkId",
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: z.infer<typeof paramsWithPageLink> }>, reply) => {
      wikiService.removeLink(request.params.pageId, request.params.linkId);
      reply.code(200).send({ success: true });
    },
  );

  fastify.get<{
    Params: z.infer<typeof paramsWithHabitat>;
    Querystring: z.infer<typeof searchQuerySchema>;
  }>(
    "/habitats/:habitatId/wiki/search",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitat>;
        Querystring: z.infer<typeof searchQuerySchema>;
      }>,
      _reply,
    ) => {
      requireHabitat(request.params.habitatId);

      const parsed = searchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }

      const results = wikiService.searchPages(request.params.habitatId, parsed.data.q, {
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      return { results };
    },
  );

  fastify.post<{
    Params: z.infer<typeof paramsWithHabitat>;
    Body: z.infer<typeof noUpdateNeededSchema>;
  }>(
    "/habitats/:habitatId/wiki/coverage/no-update-needed",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitat>;
        Body: z.infer<typeof noUpdateNeededSchema>;
      }>,
      reply,
    ) => {
      requireHabitat(request.params.habitatId);

      const parsed = noUpdateNeededSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
      }

      const createdBy = request.agent?.id ?? request.user!.id;
      const marker = wikiService.postNoUpdateNeeded(
        request.params.habitatId,
        parsed.data,
        createdBy,
      );
      reply.code(201).send({ marker });
    },
  );

  fastify.get<{ Params: z.infer<typeof paramsWithHabitatAndPage> }>(
    "/habitats/:habitatId/wiki/pages/:pageId/authoring-context",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{ Params: z.infer<typeof paramsWithHabitatAndPage> }>,
      _reply: FastifyReply,
    ) => {
      const context = augmentation.getAuthoringContextForEdit(request.params.pageId);
      return { context };
    },
  );

  fastify.post<{
    Params: z.infer<typeof paramsWithHabitat>;
    Body: { from: string; to: string; query?: string };
  }>(
    "/habitats/:habitatId/wiki/authoring-context",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitat>;
        Body: { from: string; to: string; query?: string };
      }>,
      _reply: FastifyReply,
    ) => {
      requireHabitat(request.params.habitatId);
      const chunkBody = z
        .object({
          from: z.string().min(1),
          to: z.string().min(1),
          query: z.string().optional(),
        })
        .safeParse(request.body);
      if (!chunkBody.success) {
        throw badRequest(chunkBody.error.issues.map((i) => i.message).join("; "));
      }

      const context = augmentation.getAuthoringContextForChunk(
        request.params.habitatId,
        chunkBody.data,
      );
      return { context };
    },
  );

  fastify.get<{ Params: z.infer<typeof paramsWithHabitat> }>(
    "/habitats/:habitatId/wiki/cadence",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{ Params: z.infer<typeof paramsWithHabitat> }>,
      _reply: FastifyReply,
    ) => {
      requireHabitat(request.params.habitatId);
      const cadence = scheduler.getCadence(request.params.habitatId);
      return { cadence };
    },
  );

  fastify.put<{
    Params: z.infer<typeof paramsWithHabitat>;
    Body: {
      enabled: boolean;
      scheduleType: "interval" | "cron";
      intervalMinutes?: number;
      cronExpression?: string;
      timezone?: string;
    };
  }>(
    "/habitats/:habitatId/wiki/cadence",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{
        Params: z.infer<typeof paramsWithHabitat>;
        Body: {
          enabled: boolean;
          scheduleType: "interval" | "cron";
          intervalMinutes?: number;
          cronExpression?: string;
          timezone?: string;
        };
      }>,
      _reply: FastifyReply,
    ) => {
      requireHabitat(request.params.habitatId);
      const cadenceBody = z
        .object({
          enabled: z.boolean(),
          scheduleType: z.enum(["interval", "cron"]),
          intervalMinutes: z.number().int().min(1).optional(),
          cronExpression: z.string().min(1).optional(),
          timezone: z.string().optional(),
        })
        .safeParse(request.body);
      if (!cadenceBody.success) {
        throw badRequest(cadenceBody.error.issues.map((i) => i.message).join("; "));
      }
      const createdBy = request.agent?.id ?? request.user!.id;
      const cadence = scheduler.setCadence(request.params.habitatId, cadenceBody.data, createdBy);
      return { cadence };
    },
  );

  fastify.delete<{ Params: z.infer<typeof paramsWithHabitat> }>(
    "/habitats/:habitatId/wiki/cadence",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{ Params: z.infer<typeof paramsWithHabitat> }>,
      reply: FastifyReply,
    ) => {
      requireHabitat(request.params.habitatId);
      scheduler.disableCadence(request.params.habitatId);
      reply.code(200).send({ success: true });
    },
  );

  fastify.post<{ Params: z.infer<typeof paramsWithHabitat> }>(
    "/habitats/:habitatId/wiki/bootstrap",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{ Params: z.infer<typeof paramsWithHabitat> }>,
      _reply: FastifyReply,
    ) => {
      requireHabitat(request.params.habitatId);
      const createdBy = request.agent?.id ?? request.user!.id;
      const result = scheduler.triggerBootstrap(request.params.habitatId, { createdBy });
      return result;
    },
  );

  fastify.post<{ Params: z.infer<typeof paramsWithHabitat> }>(
    "/habitats/:habitatId/wiki/refresh",
    { preHandler: agentOrHumanAuth },
    async (
      request: FastifyRequest<{ Params: z.infer<typeof paramsWithHabitat> }>,
      _reply: FastifyReply,
    ) => {
      requireHabitat(request.params.habitatId);
      const createdBy = request.agent?.id ?? request.user!.id;
      const result = scheduler.triggerRefresh(request.params.habitatId, { createdBy });
      return result;
    },
  );
}
