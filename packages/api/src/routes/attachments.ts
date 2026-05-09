import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import * as attachmentRepo from '../repositories/attachment.js';
import * as fileStorage from '../services/fileStorage.js';
import { agentOrHumanAuth } from '../middleware/auth.js';
import { getPrincipalFromRequest } from '../middleware/taskAuth.js';
import { authorizeAttachmentAccess, encodeContentDisposition } from '../middleware/attachmentAuth.js';
import { getTaskById } from '../repositories/task.js';

const MAX_UPLOAD_SIZE_MB = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '50', 10);
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

export async function attachmentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_SIZE_BYTES,
    },
  });

  fastify.post<{ Params: { taskId: string } }>(
    '/tasks/:taskId/attachments',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
      const task = getTaskById(request.params.taskId);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const data = await request.file();
      if (!data) {
        reply.code(400).send({ error: 'No file uploaded' });
        return;
      }

      const buffer = await data.toBuffer();

      if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
        reply.code(413).send({ error: `File size exceeds ${MAX_UPLOAD_SIZE_MB}MB limit` });
        return;
      }

      const uploadedBy = request.agent?.id ?? request.user?.id ?? null;
      const id = crypto.randomUUID();
      const storedName = fileStorage.saveFile(id, data.filename, buffer);

      const attachment = attachmentRepo.createAttachment({
        taskId: request.params.taskId,
        filename: storedName,
        originalName: data.filename,
        mimeType: data.mimetype,
        sizeBytes: buffer.length,
        uploadedBy,
      });

      reply.code(201).send({ attachment });
    }
  );

  fastify.get<{ Params: { taskId: string } }>(
    '/tasks/:taskId/attachments',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
      const task = getTaskById(request.params.taskId);
      if (!task) {
        reply.code(404).send({ error: 'Task not found' });
        return;
      }

      const attachments = attachmentRepo.getAttachmentsByTaskId(request.params.taskId);
      return { attachments };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/attachments/:id/download',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const attachment = attachmentRepo.getAttachmentById(request.params.id);
      if (!attachment) {
        reply.code(404).send({ error: 'Attachment not found' });
        return;
      }

      const principal = getPrincipalFromRequest(request);
      const authResult = authorizeAttachmentAccess(attachment, principal, 'read');
      if (!authResult.allowed) {
        reply.code(403).send({ error: authResult.reason });
        return;
      }

      try {
        const stream = fileStorage.readFile(attachment.filename);
        reply.header('Content-Type', attachment.mimeType);
        reply.header('Content-Disposition', encodeContentDisposition(attachment.originalName));
        reply.send(stream);
      } catch {
        reply.code(404).send({ error: 'File not found on disk' });
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/attachments/:id',
    { preHandler: agentOrHumanAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const attachment = attachmentRepo.getAttachmentById(request.params.id);
      if (!attachment) {
        reply.code(404).send({ error: 'Attachment not found' });
        return;
      }

      const principal = getPrincipalFromRequest(request);
      const authResult = authorizeAttachmentAccess(attachment, principal, 'delete');
      if (!authResult.allowed) {
        reply.code(403).send({ error: authResult.reason });
        return;
      }

      const success = attachmentRepo.deleteAttachment(request.params.id);
      if (!success) {
        reply.code(404).send({ error: 'Attachment not found' });
        return;
      }

      reply.code(204).send();
    }
  );
}
