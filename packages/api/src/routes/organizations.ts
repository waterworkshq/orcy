import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as orgRepo from '../repositories/organization.js';
import * as teamRepo from '../repositories/team.js';
import * as memberRepo from '../repositories/teamMember.js';
import { humanAuth } from '../middleware/auth.js';
import { teamAdminOrOwner, teamExists } from '../middleware/team.js';

const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
});

const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
});

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['owner', 'admin', 'member']).optional().default('member'),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member']),
});

export async function organizationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/organizations',
    { preHandler: humanAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createOrgSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const existing = orgRepo.getOrganizationBySlug(parsed.data.slug);
      if (existing) {
        reply.code(409).send({ error: 'Organization slug already exists' });
        return;
      }

      const org = orgRepo.createOrganization(parsed.data);
      reply.code(201).send({ organization: org });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/organizations/:id',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const org = orgRepo.getOrganizationById(request.params.id);
      if (!org) {
        reply.code(404).send({ error: 'Organization not found' });
        return;
      }
      return { organization: org };
    }
  );

  fastify.get(
    '/organizations',
    { preHandler: humanAuth },
    async () => {
      return { organizations: orgRepo.listOrganizations() };
    }
  );

  fastify.post<{ Params: { id: string }; Body: z.infer<typeof createTeamSchema> }>(
    '/organizations/:id/teams',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof createTeamSchema> }>, reply: FastifyReply) => {
      const org = orgRepo.getOrganizationById(request.params.id);
      if (!org) {
        reply.code(404).send({ error: 'Organization not found' });
        return;
      }

      const parsed = createTeamSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const team = teamRepo.createTeam({
        organizationId: org.id,
        name: parsed.data.name,
        slug: parsed.data.slug,
      });

      if (request.user) {
        memberRepo.addMember({
          teamId: team.id,
          userId: request.user.id,
          role: 'owner',
        });
      }

      reply.code(201).send({ team });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/organizations/:id/teams',
    { preHandler: humanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const org = orgRepo.getOrganizationById(request.params.id);
      if (!org) {
        reply.code(404).send({ error: 'Organization not found' });
        return;
      }
      return { teams: teamRepo.listTeamsByOrganization(org.id) };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/teams/:id',
    { preHandler: [humanAuth, teamExists] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const team = teamRepo.getTeamById(request.params.id);
      if (!team) {
        reply.code(404).send({ error: 'Team not found' });
        return;
      }
      return { team };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/teams/:id',
    { preHandler: [humanAuth, teamAdminOrOwner] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      teamRepo.deleteTeam(request.params.id);
      reply.code(204).send();
    }
  );

  fastify.post<{ Params: { id: string }; Body: z.infer<typeof addMemberSchema> }>(
    '/teams/:id/members',
    { preHandler: [humanAuth, teamExists, teamAdminOrOwner] },
    async (request: FastifyRequest<{ Params: { id: string }; Body: z.infer<typeof addMemberSchema> }>, reply: FastifyReply) => {
      const parsed = addMemberSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const existing = memberRepo.getMember(request.params.id, parsed.data.userId);
      if (existing) {
        reply.code(409).send({ error: 'User is already a member of this team' });
        return;
      }

      const member = memberRepo.addMember({
        teamId: request.params.id,
        userId: parsed.data.userId,
        role: parsed.data.role,
      });

      reply.code(201).send({ member });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/teams/:id/members',
    { preHandler: [humanAuth, teamExists] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      return { members: memberRepo.listMembers(request.params.id) };
    }
  );

  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/teams/:id/members/:userId',
    { preHandler: [humanAuth, teamExists, teamAdminOrOwner] },
    async (request: FastifyRequest<{ Params: { id: string; userId: string } }>, reply: FastifyReply) => {
      memberRepo.removeMember(request.params.id, request.params.userId);
      reply.code(204).send();
    }
  );

  fastify.patch<{ Params: { id: string; userId: string }; Body: z.infer<typeof updateMemberRoleSchema> }>(
    '/teams/:id/members/:userId',
    { preHandler: [humanAuth, teamExists, teamAdminOrOwner] },
    async (request: FastifyRequest<{ Params: { id: string; userId: string }; Body: z.infer<typeof updateMemberRoleSchema> }>, reply: FastifyReply) => {
      const parsed = updateMemberRoleSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
        return;
      }

      const member = memberRepo.updateMemberRole(request.params.id, request.params.userId, parsed.data.role);
      if (!member) {
        reply.code(404).send({ error: 'Member not found' });
        return;
      }
      return { member };
    }
  );

  fastify.get(
    '/users/me/teams',
    { preHandler: humanAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        reply.code(401).send({ error: 'Authentication required' });
        return;
      }
      return { teams: teamRepo.listTeamsByUserId(request.user.id) };
    }
  );
}
