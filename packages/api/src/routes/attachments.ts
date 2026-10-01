import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import * as attachmentRepo from '../repositories/attachment.js';
import * as fileStorage from '../services/fileStorage.js';
import { badRequest, notFound, forbidden, payloadTooLarge } from '../errors.js';
import { getPrincipalFromRequest } from '../middleware/taskAuth.js';
import { authorizeAttachmentAccess, encodeContentDisposition } from '../middleware/attachmentAuth.js';
import { authorizeTaskAccess } from '../middleware/realtimeAuth.js';
import { applyDeclaredAuthPolicies } from "../authPolicy.js";

const MAX_UPLOAD_SIZE_MB = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '50', 10);
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

export async function attachmentRoutes(fastify: FastifyInstance): Promise<void> {
  applyDeclaredAuthPolicies(fastify);

  fastify.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_SIZE_BYTES,
    },
  });

  fastify.post<{ Params: { taskId: string } }>(
    '/tasks/:taskId/attachments',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.taskId);

      const data = await request.file();
      if (!data) {
        throw badRequest('No file uploaded');
      }

      const buffer = await data.toBuffer();

      if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
        throw payloadTooLarge(`File size exceeds ${MAX_UPLOAD_SIZE_MB}MB limit`);
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
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { taskId: string } }>, _reply: FastifyReply) => {
      await authorizeTaskAccess(request, request.params.taskId);

      const attachments = attachmentRepo.getAttachmentsByTaskId(request.params.taskId);
      return { attachments };
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/attachments/:id/download',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const attachment = attachmentRepo.getAttachmentById(request.params.id);
      if (!attachment) {
        throw notFound('Attachment not found');
      }

      await authorizeTaskAccess(request, attachment.taskId);

      const principal = getPrincipalFromRequest(request);
      const authResult = authorizeAttachmentAccess(attachment, principal, 'read');
      if (!authResult.allowed) {
        throw forbidden(authResult.reason ?? 'Access denied');
      }

      const stream = fileStorage.readFile(attachment.filename);
      reply.header('Content-Type', attachment.mimeType);
      reply.header('Content-Disposition', encodeContentDisposition(attachment.originalName));
      return reply.send(stream);
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/attachments/:id',
    { config: { authPolicy: "local_actor" } },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const attachment = attachmentRepo.getAttachmentById(request.params.id);
      if (!attachment) {
        throw notFound('Attachment not found');
      }

      await authorizeTaskAccess(request, attachment.taskId);

      const principal = getPrincipalFromRequest(request);
      const authResult = authorizeAttachmentAccess(attachment, principal, 'delete');
      if (!authResult.allowed) {
        throw forbidden(authResult.reason ?? 'Access denied');
      }

      // DB-first destructive command: the repository revalidates current
      // authority and the full admitted preimage in one immediate
      // transaction, deletes conditionally with RETURNING + absence proof,
      // and only then unlinks the removed row's file. Success is 204.
      attachmentRepo.deleteAttachment(request, attachment);

      reply.code(204).send();
    }
  );
}
