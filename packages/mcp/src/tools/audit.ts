import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';

export const ADMIN_EXPORT_AUDIT_LOG_TOOL: Tool = {
  name: 'admin_export_audit_log',
  description:
    'Export the audit log for a board. Returns events in the specified format (csv, json, or jsonl). ' +
    'Supports filtering by date range, action types, actor type, and actor ID.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Habitat ID',
      },
      format: {
        type: 'string',
        enum: ['csv', 'json', 'jsonl'],
        description: 'Export format',
      },
      since: {
        type: 'string',
        description: 'ISO 8601 start date (optional)',
      },
      until: {
        type: 'string',
        description: 'ISO 8601 end date (optional)',
      },
      actions: {
        type: 'string',
        description: 'Comma-separated action types to filter (optional)',
      },
      actorType: {
        type: 'string',
        enum: ['human', 'agent', 'system'],
        description: 'Filter by actor type (optional)',
      },
      actorId: {
        type: 'string',
        description: 'Filter by actor ID (optional)',
      },
      entityTypes: {
        type: 'string',
        description: "'task', 'feature', or 'task,feature' (default: both)",
      },
    },
    required: ['boardId', 'format'],
  },
};

export async function adminExportAuditLog(
  client: KanbanApiClient,
  args: {
    boardId: string;
    format: 'csv' | 'json' | 'jsonl';
    since?: string;
    until?: string;
    actions?: string;
    actorType?: string;
    actorId?: string;
    entityTypes?: string;
  }
) {
  return client.exportAuditLog(args.boardId, args);
}

export const ADMIN_GET_AUDIT_SUMMARY_TOOL: Tool = {
  name: 'admin_get_audit_summary',
  description:
    'Get audit summary statistics for a board: total events, breakdown by action type, ' +
    'by actor type, daily counts, and top features.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Habitat ID',
      },
      since: {
        type: 'string',
        description: 'ISO 8601 start date (optional)',
      },
      until: {
        type: 'string',
        description: 'ISO 8601 end date (optional)',
      },
    },
    required: ['boardId'],
  },
};

export async function adminGetAuditSummary(
  client: KanbanApiClient,
  args: { boardId: string; since?: string; until?: string }
) {
  return client.getAuditSummary(args.boardId, { since: args.since, until: args.until });
}
