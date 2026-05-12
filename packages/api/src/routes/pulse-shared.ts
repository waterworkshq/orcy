import type { FastifyRequest } from 'fastify';

export const VALID_SIGNAL_TYPES = [
  'finding', 'blocker', 'offer', 'warning',
  'question', 'answer', 'directive', 'context', 'handoff',
] as const;

export type SignalType = typeof VALID_SIGNAL_TYPES[number];

export function getCallerInfo(request: FastifyRequest): { type: 'human' | 'agent'; id: string } | null {
  if (request.agent) return { type: 'agent', id: request.agent.id };
  if (request.user) return { type: 'human', id: request.user.id };
  return null;
}
