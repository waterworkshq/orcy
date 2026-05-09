import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initTestDb, closeDb } from '../db/index.js';
import * as agentRepo from '../repositories/agent.js';
import * as boardRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as featureRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as attachmentRepo from '../repositories/attachment.js';
import { attachmentRoutes } from '../routes/attachments.js';
import { authorizeAttachmentAccess } from '../middleware/attachmentAuth.js';
import { getPrincipalFromRequest } from '../middleware/taskAuth.js';

function mockReqRes(overrides: Record<string, any> = {}) {
  const request: any = {
    params: {},
    query: {},
    body: {},
    agent: undefined,
    user: undefined,
    headers: {},
    ...overrides,
  };
  const sent: any = { code: null, body: null };
  const reply: any = {
    code: vi.fn((c: number) => { sent.code = c; return reply; }),
    send: vi.fn((b: any) => { sent.body = b; return reply; }),
    header: vi.fn(() => reply),
  };
  return { request, reply, sent };
}

type RouteHandler = (req: any, reply: any) => Promise<void>;
interface CapturedRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    register: vi.fn(),
    post: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'POST', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    get: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'GET', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    put: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'PUT', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    delete: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'DELETE', path, handler: typeof opts === 'function' ? opts : handler });
    }),
  };
  attachmentRoutes(fakeFastify);
  return routes;
}

function findRoute(routes: CapturedRoute[], method: string, pathPattern: string): RouteHandler {
  const r = routes.find(r => r.method === method && r.path.includes(pathPattern));
  if (!r) throw new Error(`Route ${method} ${pathPattern} not found`);
  return r.handler;
}

describe('Attachment Security', () => {
  let boardId: string;
  let columnId: string;
  let featureId: string;
  let taskId: string;
  let agent1Id: string;
  let agent2Id: string;
  let routes: CapturedRoute[];

  beforeEach(async () => {
    await initTestDb();

    const board = boardRepo.createBoard({ name: 'Attachment Security Board' });
    boardId = board.id;

    const col = columnRepo.createColumn({
      boardId,
      name: 'Todo',
      order: 0,
    });
    columnId = col.id;

    const feature = featureRepo.createFeature({
      boardId,
      columnId,
      title: 'Test Feature',
      description: 'desc',
      priority: 'medium',
      labels: [],
      createdBy: 'test',
    });
    featureId = feature.id;

    const task = taskRepo.createTask({
      featureId,
      title: 'Test Task',
      description: 'desc',
      priority: 'medium',
      createdBy: 'test',
    });
    taskId = task.id;

    const a1 = agentRepo.createAgent({ name: 'agent-a', type: 'claude-code', domain: 'backend' });
    agent1Id = a1.agent.id;

    const a2 = agentRepo.createAgent({ name: 'agent-b', type: 'opencode', domain: 'frontend' });
    agent2Id = a2.agent.id;

    routes = captureRoutes();
  });

  afterEach(() => { closeDb(); });

  describe('authorizeAttachmentAccess — unit', () => {
    it('allows human admin to read any attachment', () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const result = authorizeAttachmentAccess(attachment, {
        type: 'human',
        id: 'human-1',
        role: 'admin',
      }, 'read');

      expect(result.allowed).toBe(true);
    });

    it('allows assigned agent to read attachment on assigned task', () => {
      taskRepo.updateTask(taskId, { assignedAgentId: agent2Id });

      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const result = authorizeAttachmentAccess(attachment, {
        type: 'agent',
        id: agent2Id,
      }, 'read');

      expect(result.allowed).toBe(true);
    });

    it('denies non-assigned agent from reading attachment', () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const result = authorizeAttachmentAccess(attachment, {
        type: 'agent',
        id: agent2Id,
      }, 'read');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not assigned');
    });

    it('denies read when no principal provided', () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const result = authorizeAttachmentAccess(attachment, undefined, 'read');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Authentication required');
    });

    it('allows uploader to delete', () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const result = authorizeAttachmentAccess(attachment, {
        type: 'agent',
        id: agent1Id,
      }, 'delete');

      expect(result.allowed).toBe(true);
    });

    it('allows assigned agent to delete', () => {
      taskRepo.updateTask(taskId, { assignedAgentId: agent1Id });

      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent2Id,
      });

      const result = authorizeAttachmentAccess(attachment, {
        type: 'agent',
        id: agent1Id,
      }, 'delete');

      expect(result.allowed).toBe(true);
    });

    it('allows human admin to delete', () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const result = authorizeAttachmentAccess(attachment, {
        type: 'human',
        id: 'human-1',
        role: 'admin',
      }, 'delete');

      expect(result.allowed).toBe(true);
    });

    it('allows human editor to delete', () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const result = authorizeAttachmentAccess(attachment, {
        type: 'human',
        id: 'human-1',
        role: 'editor',
      }, 'delete');

      expect(result.allowed).toBe(true);
    });

    it('denies human viewer from deleting', () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const result = authorizeAttachmentAccess(attachment, {
        type: 'human',
        id: 'human-1',
        role: 'viewer',
      }, 'delete');

      expect(result.allowed).toBe(false);
    });

    it('denies unrelated agent from deleting', () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const result = authorizeAttachmentAccess(attachment, {
        type: 'agent',
        id: agent2Id,
      }, 'delete');

      expect(result.allowed).toBe(false);
    });
  });

  describe('Cross-agent access denial — integration', () => {
    it('agent cannot delete another uploader\'s unrelated attachment', async () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const handler = findRoute(routes, 'DELETE', '/attachments/:id');

      const { request, reply, sent } = mockReqRes({
        params: { id: attachment.id },
        agent: { id: agent2Id, name: 'agent-b' },
      });

      await handler(request, reply);

      expect(sent.code).toBe(403);
      expect(attachmentRepo.getAttachmentById(attachment.id)).not.toBeNull();
    });

    it('authorized uploader can delete their own attachment', async () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const handler = findRoute(routes, 'DELETE', '/attachments/:id');

      const { request, reply, sent } = mockReqRes({
        params: { id: attachment.id },
        agent: { id: agent1Id, name: 'agent-a' },
      });

      await handler(request, reply);

      expect(sent.code).toBe(204);
      expect(attachmentRepo.getAttachmentById(attachment.id)).toBeNull();
    });

    it('human admin can delete any attachment', async () => {
      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const handler = findRoute(routes, 'DELETE', '/attachments/:id');

      const { request, reply, sent } = mockReqRes({
        params: { id: attachment.id },
        user: { id: 'admin-1', username: 'admin', role: 'admin', type: 'human' },
      });

      await handler(request, reply);

      expect(sent.code).toBe(204);
    });

    it('assigned agent can delete attachment on their task', async () => {
      taskRepo.updateTask(taskId, { assignedAgentId: agent1Id });

      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'test.txt',
        originalName: 'test.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent2Id,
      });

      const handler = findRoute(routes, 'DELETE', '/attachments/:id');

      const { request, reply, sent } = mockReqRes({
        params: { id: attachment.id },
        agent: { id: agent1Id, name: 'agent-a' },
      });

      await handler(request, reply);

      expect(sent.code).toBe(204);
    });
  });

  describe('Download filename encoding — integration', () => {
    it('download uses safe Content-Disposition header', async () => {
      taskRepo.updateTask(taskId, { assignedAgentId: agent1Id });

      const attachment = attachmentRepo.createAttachment({
        taskId,
        filename: 'safe-name.txt',
        originalName: 'my "report"; 1.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        uploadedBy: agent1Id,
      });

      const { writeFileSync, mkdirSync } = await import('fs');
      const { join } = await import('path');
      const uploadDir = process.env.UPLOAD_DIR || join(process.cwd(), 'uploads');
      mkdirSync(uploadDir, { recursive: true });
      writeFileSync(join(uploadDir, 'safe-name.txt'), 'test content');

      let capturedStream: NodeJS.ReadableStream | null = null;
      try {
        const handler = findRoute(routes, 'GET', '/attachments/:id/download');

        const headers: Record<string, string> = {};
        const { request, reply, sent } = mockReqRes({
          params: { id: attachment.id },
          agent: { id: agent1Id, name: 'agent-a' },
        });

        reply.header = vi.fn((key: string, value: string) => {
          headers[key] = value;
          return reply;
        });

        reply.send = vi.fn((data: any) => {
          if (data && typeof data === 'object' && typeof data.pipe === 'function') {
            capturedStream = data;
          }
          return reply;
        });

        await handler(request, reply);

        expect(sent.code).toBeNull();
        const cd = headers['Content-Disposition'];
        expect(cd).toBeDefined();
        expect(cd).toContain("filename*=UTF-8''");
        expect(cd).toContain('filename="');
        expect(cd).not.toContain('"report"');
      } finally {
        if (capturedStream && typeof (capturedStream as NodeJS.ReadableStream & { destroy: () => void }).destroy === 'function') {
          await new Promise<void>((resolve) => {
            capturedStream!.once('close', resolve);
            capturedStream!.once('error', resolve);
            (capturedStream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
          });
        }
        const { unlinkSync } = await import('fs');
        try { unlinkSync(join(uploadDir, 'safe-name.txt')); } catch {}
      }
    });
  });
});
