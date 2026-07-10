import type { FastifyRequest } from 'fastify';
import type { Task } from '../models/index.js';
import type { HumanRole } from './auth.js';

export interface Principal {
  type: 'agent' | 'human';
  id: string;
  role?: HumanRole;
}

export type LifecycleAction =
  | 'claim'
  | 'start'
  | 'submit'
  | 'release'
  | 'fail'
  | 'complete'
  | 'approve'
  | 'reject'
  | 'unblock';

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

const OWNER_ONLY_ACTIONS: LifecycleAction[] = ['start', 'submit', 'complete'];

const OWNER_OR_REVIEWER_ACTIONS: LifecycleAction[] = ['release', 'fail'];

const REVIEWER_ONLY_ACTIONS: LifecycleAction[] = ['approve', 'reject'];

function isAssignedAgent(task: Task, principal: Principal): boolean {
  return principal.type === 'agent' && task.assignedAgentId === principal.id;
}

function isHumanReviewer(principal: Principal): boolean {
  return principal.type === 'human' && (principal.role === 'admin' || principal.role === 'editor');
}

export function authorizeTaskAction(
  task: Task,
  principal: Principal | undefined,
  action: LifecycleAction
): AuthorizationResult {
  if (!principal || !principal.id) {
    return { allowed: false, reason: 'Authentication required' };
  }

  if (action === 'claim') {
    return { allowed: true };
  }

  if (action === 'unblock') {
    return { allowed: false, reason: 'Unblock is an internal-only action' };
  }

  if (OWNER_ONLY_ACTIONS.includes(action)) {
    if (isAssignedAgent(task, principal)) {
      return { allowed: true };
    }
    if (principal.type === 'agent') {
      return { allowed: false, reason: `Only the assigned agent can ${action} this task` };
    }
    return { allowed: false, reason: `${action} requires the assigned agent` };
  }

  if (REVIEWER_ONLY_ACTIONS.includes(action)) {
    if (isHumanReviewer(principal)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `Only a human reviewer can ${action} this task` };
  }

  if (OWNER_OR_REVIEWER_ACTIONS.includes(action)) {
    if (isAssignedAgent(task, principal)) {
      return { allowed: true };
    }
    if (isHumanReviewer(principal)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `Only the assigned agent or a human reviewer can ${action} this task` };
  }

  return { allowed: false, reason: 'Unknown action' };
}

export function getPrincipalFromRequest(request: FastifyRequest): Principal | undefined {
  if (request.agent) {
    return { type: 'agent', id: request.agent.id };
  }
  if (request.user) {
    return { type: 'human', id: request.user.id, role: request.user.role as HumanRole };
  }
  return undefined;
}

export { isAssignedAgent, isHumanReviewer };
