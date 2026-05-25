import type { FastifyError, FastifyInstance } from 'fastify';
import { isAppError, ErrorCodes } from '../errors.js';

/**
 * Registers Fastify error and 404 handlers that convert exceptions and validation
 * failures into structured JSON error responses.
 */
export async function registerErrorHandler(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id as string;

    // Application errors (AppError subclass) — log as warning and return structured response
    if (isAppError(error)) {
      fastify.log.warn({
        requestId,
        err: error,
        code: error.code,
        path: request.url,
        method: request.method,
      }, 'Handled application error');

      reply.status(error.statusCode).send({
        error: error.message,
        code: error.code,
        details: error.details,
      });
      return;
    }

    // Fastify schema validation errors
    if (error.validation) {
      fastify.log.warn({
        requestId,
        err: error,
        code: ErrorCodes.VALIDATION_ERROR,
        path: request.url,
        method: request.method,
      }, 'Validation error');

      reply.status(400).send({
        error: 'Validation failed',
        code: ErrorCodes.VALIDATION_ERROR,
        details: error.validation,
      });
      return;
    }

    // Rate limit responses (HTTP 429 from rate-limit middleware)
    if (error.statusCode === 429) {
      fastify.log.warn({
        requestId,
        code: ErrorCodes.RATE_LIMITED,
        path: request.url,
        method: request.method,
      }, 'Rate limit exceeded');

      reply.status(429).send({
        error: 'Too many requests',
        code: ErrorCodes.RATE_LIMITED,
      });
      return;
    }

    // Unhandled errors — log as error and return generic 500
    fastify.log.error({
      requestId,
      err: error,
      code: ErrorCodes.INTERNAL_ERROR,
      path: request.url,
      method: request.method,
    }, 'Unhandled error');

    reply.status(500).send({
      error: 'Internal server error',
      code: ErrorCodes.INTERNAL_ERROR,
    });
  });

  // 404 for unmatched routes — log as info and return NOT_FOUND
  fastify.setNotFoundHandler((request, reply) => {
    fastify.log.info({
      requestId: request.id as string,
      path: request.url,
      method: request.method,
    }, 'Route not found');

    reply.status(404).send({
      error: 'Not found',
      code: ErrorCodes.NOT_FOUND,
    });
  });
}
