import type { Task } from '../models/index.js';
import type { HumanRole } from './auth.js';
import type { Principal, AuthorizationResult } from './taskAuth.js';
import { isHumanReviewer } from './taskAuth.js';
import { getTaskById } from '../repositories/task.js';
import type { Attachment } from '../repositories/attachment.js';

export function authorizeAttachmentAccess(
  attachment: Attachment,
  principal: Principal | undefined,
  action: 'read' | 'delete'
): AuthorizationResult {
  if (!principal || !principal.id) {
    return { allowed: false, reason: 'Authentication required' };
  }

  const task = getTaskById(attachment.taskId);
  if (!task) {
    return { allowed: false, reason: 'Task not found' };
  }

  if (action === 'read') {
    if (principal.type === 'agent') {
      if (task.assignedAgentId === principal.id) {
        return { allowed: true };
      }
      return { allowed: false, reason: 'Agent not assigned to this task' };
    }
    if (principal.type === 'human') {
      return { allowed: true };
    }
    return { allowed: false, reason: 'Not authorized to access this attachment' };
  }

  if (action === 'delete') {
    if (attachment.uploadedBy === principal.id) {
      return { allowed: true };
    }

    if (principal.type === 'agent' && task.assignedAgentId === principal.id) {
      return { allowed: true };
    }

    if (principal.type === 'human' && (principal.role === 'admin' || principal.role === 'editor')) {
      return { allowed: true };
    }

    return { allowed: false, reason: 'Not authorized to delete this attachment' };
  }

  return { allowed: false, reason: 'Unknown action' };
}

export function encodeContentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename);
  const fallback = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
