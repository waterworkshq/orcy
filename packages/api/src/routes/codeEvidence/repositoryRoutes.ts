import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { agentOrHumanAuth, humanAuth } from "../../middleware/auth.js";
import { badRequest, notFound } from "../../errors.js";
import * as habitatRepo from "../../repositories/board.js";
import * as codeEvidenceRepository from "../../repositories/codeEvidenceRepository.js";
import * as connectionRepo from "../../repositories/integrationConnection.js";
import {
  habitatIdParamsSchema,
  inferFromIntegrationSchema,
  inferFromWorktreeSchema,
  repositoryInputSchema,
} from "./shared.js";

interface WorktreeSettingsPayload {
  path?: unknown;
  repoSlug?: unknown;
  provider?: unknown;
}

export async function repositorySettingsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.withTypeProvider<ZodTypeProvider>().get(
    "/habitats/:habitatId/repository",
    {
      schema: { params: habitatIdParamsSchema },
      preHandler: [agentOrHumanAuth],
    },
    async (request) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const repo = codeEvidenceRepository.getByHabitatId(request.params.habitatId);
      return { repository: repo };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().put(
    "/habitats/:habitatId/repository",
    {
      schema: { params: habitatIdParamsSchema, body: repositoryInputSchema },
      preHandler: [humanAuth],
    },
    async (request) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const body = request.body;
      const existing = codeEvidenceRepository.getByHabitatId(request.params.habitatId);

      if (existing) {
        const repo = codeEvidenceRepository.updateByHabitatId(request.params.habitatId, {
          provider: body.provider,
          providerBaseUrl: body.providerBaseUrl,
          externalId: body.externalId,
          repoSlug: body.repoSlug,
          displayName: body.displayName,
          localPath: body.localPath,
        });
        return { repository: repo };
      }

      if (!body.provider || !body.repoSlug) {
        throw badRequest("provider and repoSlug are required when creating a repository identity");
      }

      const repo = codeEvidenceRepository.create({
        habitatId: request.params.habitatId,
        provider: body.provider,
        providerBaseUrl: body.providerBaseUrl,
        externalId: body.externalId,
        repoSlug: body.repoSlug,
        displayName: body.displayName,
        localPath: body.localPath,
      });

      return { repository: repo };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/repository/infer-from-worktree",
    {
      schema: { params: habitatIdParamsSchema, body: inferFromWorktreeSchema },
      preHandler: [humanAuth],
    },
    async (request) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const worktreeSettings = habitat.gitWorktreeSettings as WorktreeSettingsPayload | null;
      if (!worktreeSettings || !worktreeSettings.path) {
        throw badRequest("No worktree path configured for this habitat");
      }

      const worktreePath = request.body.worktreePath ?? (worktreeSettings.path as string);
      const repoSlug = worktreeSettings.repoSlug as string | undefined;
      const provider = (worktreeSettings.provider as string | undefined) ?? "local";

      const existing = codeEvidenceRepository.getByHabitatId(request.params.habitatId);
      if (existing) {
        const updated = codeEvidenceRepository.updateByHabitatId(request.params.habitatId, {
          provider,
          repoSlug: repoSlug ?? existing.repoSlug ?? undefined,
          localPath: worktreePath,
          verificationState: "unverified",
        });
        return { repository: updated };
      }

      if (!repoSlug) {
        throw badRequest("Cannot infer repository identity: no repoSlug in worktree settings");
      }

      const repo = codeEvidenceRepository.create({
        habitatId: request.params.habitatId,
        provider,
        repoSlug,
        localPath: worktreePath,
        verificationState: "unverified",
      });

      return { repository: repo };
    },
  );

  fastify.withTypeProvider<ZodTypeProvider>().post(
    "/habitats/:habitatId/repository/infer-from-integration",
    {
      schema: { params: habitatIdParamsSchema, body: inferFromIntegrationSchema },
      preHandler: [humanAuth],
    },
    async (request) => {
      const habitat = habitatRepo.getHabitatById(request.params.habitatId);
      if (!habitat) throw notFound("Habitat not found");

      const connections = connectionRepo.listByHabitat(request.params.habitatId);
      const githubConn = connections.filter((c) => c.enabled).find((c) => c.provider === "github");

      let provider = "";
      let repoSlug = "";
      let externalId: string | undefined;
      let providerBaseUrl: string | undefined;

      if (githubConn && githubConn.repositoryOwner && githubConn.repositoryName) {
        provider = "github";
        repoSlug = `${githubConn.repositoryOwner}/${githubConn.repositoryName}`;
        externalId = githubConn.externalAccountId ?? undefined;
        providerBaseUrl = githubConn.externalBaseUrl ?? undefined;
      } else {
        throw badRequest("No GitHub integration with repository configured for this habitat");
      }

      const existing = codeEvidenceRepository.getByHabitatId(request.params.habitatId);
      if (existing) {
        const updated = codeEvidenceRepository.updateByHabitatId(request.params.habitatId, {
          provider,
          providerBaseUrl,
          externalId,
          repoSlug,
          verificationState: "unverified",
        });
        return { repository: updated };
      }

      const repo = codeEvidenceRepository.create({
        habitatId: request.params.habitatId,
        provider,
        providerBaseUrl,
        externalId,
        repoSlug,
        verificationState: "unverified",
      });

      return { repository: repo };
    },
  );
}
