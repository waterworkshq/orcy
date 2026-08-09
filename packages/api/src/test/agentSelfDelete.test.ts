import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import jwt from 'jsonwebtoken';
import { initTestDb, closeDb } from '../db/index.js';
import { agentRoutes } from '../routes/agents.js';
import * as agentRepo from '../repositories/agent.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as columnRepo from '../repositories/column.js';
import * as missionRepo from '../repositories/mission.js';
import * as taskRepo from '../repositories/task.js';

const JWT_SECRET = 'dev-secret-change-in-production';

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: 'orcy' });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(agentRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('DELETE /agents/:id/self', () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it('agent deleting itself returns 204 and removes the record', async () => {
    const created = agentRepo.createAgent({
      name: 'self-delete-agent',
      type: 'claude-code',
      domain: 'backend',
    });

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/agents/${created.agent.id}/self`,
      headers: { 'x-agent-api-key': created.plainApiKey },
    });
    expect(res.statusCode).toBe(204);

    // Record should be gone
    expect(agentRepo.getAgentById(created.agent.id)).toBeNull();
  });

  it('agent deleting itself releases its held task', async () => {
    // Seed: habitat → column → mission → task → claim
    const habitat = habitatRepo.createHabitat({ name: 'Self-Delete Habitat' });
    columnRepo.createColumn({ habitatId: habitat.id, name: 'Todo', order: 0 });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      title: 'Test Mission',
      createdBy: 'user-1',
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: 'Test Task',
      createdBy: 'user-1',
    });

    const created = agentRepo.createAgent({
      name: 'task-holding-agent',
      type: 'claude-code',
      domain: 'backend',
    });

    const claimResult = taskRepo.claimTask(task.id, created.agent.id);
    expect(claimResult.success).toBe(true);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/agents/${created.agent.id}/self`,
      headers: { 'x-agent-api-key': created.plainApiKey },
    });
    expect(res.statusCode).toBe(204);

    // Agent gone
    expect(agentRepo.getAgentById(created.agent.id)).toBeNull();

    // Task released — agentService.deleteAgent calls taskRepo.releaseTask(reason "system")
    const releasedTask = taskRepo.getTaskById(task.id);
    expect(releasedTask).not.toBeNull();
    expect(releasedTask!.assignedAgentId).toBeNull();
  });

  it('agent deleting another agent id returns 403', async () => {
    const agentA = agentRepo.createAgent({
      name: 'agent-a',
      type: 'claude-code',
      domain: 'backend',
    });
    const agentB = agentRepo.createAgent({
      name: 'agent-b',
      type: 'claude-code',
      domain: 'backend',
    });

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/agents/${agentB.agent.id}/self`,
      headers: { 'x-agent-api-key': agentA.plainApiKey },
    });
    expect(res.statusCode).toBe(403);

    // Both agents should still exist
    expect(agentRepo.getAgentById(agentA.agent.id)).not.toBeNull();
    expect(agentRepo.getAgentById(agentB.agent.id)).not.toBeNull();
  });

  it('admin DELETE /agents/:id still works', async () => {
    const created = agentRepo.createAgent({
      name: 'admin-delete-agent',
      type: 'claude-code',
      domain: 'backend',
    });

    const token = makeToken({ sub: 'admin-1', username: 'admin', role: 'admin' });
    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/agents/${created.agent.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
    expect(agentRepo.getAgentById(created.agent.id)).toBeNull();
  });
});
