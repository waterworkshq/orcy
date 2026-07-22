import type { MissionClient } from "../api/interfaces.js";
import type { TaskPublicationOutcome, ClonePreparation } from "../api/interfaces.js";
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import { randomUUID } from 'crypto';
import { ApiClientError } from '@orcy/shared';
import { PRIORITY_LEVELS, FEATURE_STATUSES } from './constants.js';

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const HABITAT_CREATE_MISSION_TOOL: Tool = {
  name: 'habitat_create_mission',
  description:
    'Create a new mission in a habitat. Missions are the top-level work items that flow through habitat columns. ' +
    'Add tasks within missions using mission_create_task.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Habitat ID',
      },
      title: {
        type: 'string',
        description: 'Mission title',
      },
      description: {
        type: 'string',
        description: 'Mission description — the "brief" that provides context for all tasks within this mission',
      },
      acceptanceCriteria: {
        type: 'string',
        description: 'What defines this mission as complete',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Mission priority (default: medium)',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels to categorize the mission',
      },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
        description: 'Mission IDs this mission depends on',
      },
      dueAt: {
        type: 'string',
        description: 'ISO 8601 deadline for the mission',
      },
      slaMinutes: {
        type: 'number',
        description: 'Service-level agreement in minutes (triggers escalation if mission is not done by deadline = createdAt + slaMinutes)',
      },
      blocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Mission IDs that this mission blocks',
      },
    },
    required: ['boardId', 'title'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function habitatCreateMission(
  client: KanbanApiClient,
  args: {
    boardId: string;
    title: string;
    description?: string;
    acceptanceCriteria?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    labels?: string[];
    dependsOn?: string[];
    dueAt?: string;
    slaMinutes?: number;
    blocks?: string[];
  }
) {
  const result = await client.createMission(args.boardId, {
    title: args.title,
    description: args.description,
    acceptanceCriteria: args.acceptanceCriteria,
    priority: args.priority,
    labels: args.labels,
    dependsOn: args.dependsOn,
    dueAt: args.dueAt,
    slaMinutes: args.slaMinutes,
    blocks: args.blocks,
  });
  return { mission: result.mission };
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const HABITAT_LIST_MISSIONS_TOOL: Tool = {
  name: 'habitat_list_missions',
  description:
    'List missions in a habitat with progress information. Missions are the habitat cards; tasks live inside missions.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Habitat ID',
      },
      status: {
        type: 'string',
        enum: [...FEATURE_STATUSES],
        description: 'Filter by mission status',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Filter by priority',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of missions to return (default: 20)',
      },
      isArchived: {
        type: 'boolean',
        description: 'Set to true to retrieve archived missions instead of active ones (default: false)',
      },
    },
    required: ['boardId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function habitatListMissions(
  client: KanbanApiClient,
  args: { boardId: string; status?: string; priority?: string; limit?: number; isArchived?: boolean }
) {
  return client.listMissions(args.boardId, {
    status: args.status,
    priority: args.priority,
    limit: args.limit,
    isArchived: args.isArchived,
  });
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const MISSION_LIST_TASKS_TOOL: Tool = {
  name: 'mission_list_tasks',
  description:
    'List all tasks within a mission. Tasks are the work units that agents claim and complete.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Mission ID',
      },
    },
    required: ['missionId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function missionListTasks(
  client: KanbanApiClient,
  args: { missionId: string }
) {
  return client.listTasksInMission(args.missionId);
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const MISSION_CREATE_TASK_TOOL: Tool = {
  name: 'mission_create_task',
  description:
    'Create a task within a mission. Tasks are implementation steps that agents claim, work on, and submit.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Parent mission ID',
      },
      title: {
        type: 'string',
        description: 'Task title',
      },
      description: {
        type: 'string',
        description: 'Detailed description with context and expected behavior',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Task priority (default: medium)',
      },
      requiredDomain: {
        type: 'string',
        description: 'Domain filter: frontend, backend, devops, testing, or fullstack',
      },
      requiredCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required capabilities (e.g., ["typescript", "react"])',
      },
      estimatedMinutes: {
        type: 'number',
        description: 'Estimated time to complete in minutes',
      },
    },
    required: ['missionId', 'title'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function missionCreateTask(
  client: KanbanApiClient,
  args: {
    missionId: string;
    title: string;
    description?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    requiredDomain?: string | null;
    requiredCapabilities?: string[];
    estimatedMinutes?: number;
  }
) {
  let publication: TaskPublicationOutcome;
  try {
    publication = await client.publishTaskInMission(args.missionId, {
      attemptKey: randomUUID(),
      title: args.title,
      ...(args.description !== undefined && { description: args.description }),
      ...(args.priority !== undefined && { priority: args.priority }),
      ...(args.requiredDomain !== undefined && { requiredDomain: args.requiredDomain }),
      ...(args.requiredCapabilities !== undefined && {
        requiredCapabilities: args.requiredCapabilities,
      }),
      ...(args.estimatedMinutes !== undefined && { estimatedMinutes: args.estimatedMinutes }),
    });
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) {
      const legacy = await client.createTaskInMission(args.missionId, {
        title: args.title,
        description: args.description,
        priority: args.priority,
        requiredDomain: args.requiredDomain,
        requiredCapabilities: args.requiredCapabilities,
        estimatedMinutes: args.estimatedMinutes,
      });
      return { task: legacy.task };
    }
    throw err;
  }
  if (publication.taskId === undefined) {
    throw new Error(
      `Task publication ${publication.attemptId} completed without a task id`,
    );
  }
  return client.getTask(publication.taskId);
}

/**
 * T6 Phase 3a — dormant publication tool (a sibling of
 * {@link MISSION_CREATE_TASK_TOOL} that targets the dormant publication
 * route `POST /missions/:missionId/task-publications`).
 *
 * Why a sibling rather than a replacement:
 *   The kernel's shared publication contract (T5) is landed DORMANT — the
 *   legacy {@link MISSION_CREATE_TASK_TOOL} / `mission_create_task` /
 *   `createTaskInMission` / `POST /missions/:missionId/tasks` stay the
 *   active production path until T11 swaps them. This tool ships alongside
 *   them, exercised only by tests (the sole dormancy exerciser). It is NOT
 *   registered in `ALL_TOOLS` / `TASK_ACTIONS` (mirroring how
 *   {@link MISSION_CREATE_TASK_TOOL} is also a standalone export not wired
 *   into the dispatch — only its handler sibling `missionCreateTask` is
 *   dispatched via `TASK_ACTIONS["create-in-mission"]`, which is the ACTIVE
 *   production path and stays byte-unchanged).
 *
 * Provenance:
 *   The MCP client is an HTTP wrapper — the REST route derives
 *   `auditSource:"rest_api"` + `actorType:"agent"` from the authenticated
 *   MCP caller. This tool MUST NOT assert `auditSource` in its input (the
 *   body is untrusted; an LLM client could spoof `"mcp_tool"` to mask its
 *   tracks). A future trusted `"mcp_tool"` distinction requires a
 *   server-side header + a route read (post-cutover hardening).
 *
 * Idempotent retry contract:
 *   `attemptKey` is the client-supplied attempt identity. The handler
 *   generates a UUID when the caller omits one and ALWAYS returns the
 *   `attemptKey` used in the result so the LLM can retry an unchanged
 *   publication with the same key (the adapter reserves/replays off the
 *   key). Editing a known terminal rejection uses a NEW key; unchanged
 *   retry keeps the old key.
 *
 * Outcome interpretation:
 *   The handler does NOT throw for domain outcomes — validation/veto/
 *   recovering/replay are normal publication results, not errors. The route
 *   forwards 422/409/503 bodies verbatim; the handler parses them out of
 *   the {@link ApiClientError} and returns a clear LLM-facing result object
 *   with a `message` field explaining the next action (retry same key /
 *   new key / poll the attempt).
 *
 * See: T6 ticket § "Execution phases" (P3a) + § "Phase 2 carry-over".
 */
export const MISSION_PUBLISH_TASK_TOOL: Tool = {
  name: 'mission_publish_task',
  description:
    'Publish a task within a mission via the shared publication contract (dormant — prefer mission_create_task until the cutover). ' +
    'Idempotent: pass the same attemptKey to retry an unchanged Publish; use a new attemptKey only when changing a rejected payload. ' +
    'Returns a clear result object (created/recovering/replayed/rejected_validation/vetoed/rejected_fingerprint/guard_mismatch/governance_denied) with the attemptKey used.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Parent mission ID',
      },
      attemptKey: {
        type: 'string',
        description:
          'Client-supplied attempt identity for idempotent retry. Retain across unchanged Publishes; ' +
          'use a new key only when changing a previously-rejected payload. Omit to have the handler generate a UUID.',
      },
      title: {
        type: 'string',
        description: 'Task title',
      },
      description: {
        type: 'string',
        description: 'Detailed description with context and expected behavior',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Task priority (default: medium)',
      },
      requiredDomain: {
        type: 'string',
        description: 'Domain filter: frontend, backend, devops, testing, or fullstack',
      },
      requiredCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required capabilities (e.g., ["typescript", "react"])',
      },
      estimatedMinutes: {
        type: 'number',
        description: 'Estimated time to complete in minutes',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels to categorize the task',
      },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task UUIDs this task depends on (must complete first)',
      },
      assignment: {
        type: 'object',
        description:
          "Assignment intent (defaults to {kind:'auto'}). For targeted, supply {kind:'targeted', agentId} AND targetedAssignmentDeadline.",
        properties: {
          kind: { type: 'string', enum: ['auto', 'targeted'] },
          agentId: {
            type: 'string',
            description: 'Target agent UUID (required when kind === "targeted")',
          },
        },
        required: ['kind'],
      },
      targetedAssignmentDeadline: {
        type: 'string',
        description:
          'ISO 8601 timestamp; REQUIRED when assignment.kind === "targeted" (the adapter reserves the seat until this deadline).',
      },
    },
    required: ['missionId', 'title'],
  },
};

/** Publication outcomes that arrive as ApiClientError bodies (422/409/503) —
 * domain results the handler interprets rather than re-throws. */
const PUBLICATION_DOMAIN_OUTCOMES = new Set<TaskPublicationOutcome['outcome']>([
  'created',
  'replayed',
  'rejected_validation',
  'vetoed',
  'rejected_fingerprint',
  'guard_mismatch',
  'governance_denied',
]);

/**
 * Parses the JSON body the publication route sent on a non-2xx response out
 * of the {@link ApiClientError} message (the transport surfaces them as
 * `API <status>: <body>`). Returns `null` when the body is not a
 * publication-outcome envelope (so the handler can re-throw the original
 * error for non-domain failures — e.g. a 500 from a programming bug).
 */
function parsePublicationErrorBody(err: ApiClientError): TaskPublicationOutcome | null {
  const raw = err.message.replace(/^API \d+: /, '');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as TaskPublicationOutcome).outcome === 'string' &&
      PUBLICATION_DOMAIN_OUTCOMES.has((parsed as TaskPublicationOutcome).outcome) &&
      typeof (parsed as TaskPublicationOutcome).attemptId === 'string'
    ) {
      return parsed as TaskPublicationOutcome;
    }
  } catch {
    // Not JSON — fall through; the error is not a publication domain outcome.
  }
  return null;
}

/**
 * Maps a {@link TaskPublicationOutcome} to a clear LLM-facing result object.
 *
 * The result ALWAYS carries `attemptKey` so the caller can retry an
 * unchanged publication with the same key (or switch to a new key for a
 * corrected payload — the `message` field explains which). Recovering /
 * validation / veto / fingerprint / guard outcomes are results, NOT errors
 * — the handler does not throw them.
 */
function interpretPublicationOutcome(
  outcome: TaskPublicationOutcome,
  attemptKey: string,
): Record<string, unknown> {
  const base = { attemptKey };
  switch (outcome.outcome) {
    case 'created':
      if (outcome.recovering) {
        return {
          ...base,
          outcome: 'created',
          attemptId: outcome.attemptId,
          ...(outcome.taskId !== undefined && { taskId: outcome.taskId }),
          recovering: true,
          ...(outcome.recoveringState !== undefined && { recoveringState: outcome.recoveringState }),
          message:
            'Task committed but still recovering — poll the attempt to confirm it is observed before reporting success.',
        };
      }
      return {
        ...base,
        outcome: 'created',
        attemptId: outcome.attemptId,
        ...(outcome.taskId !== undefined && { taskId: outcome.taskId }),
        message: 'Task created.',
      };
    case 'replayed':
      return {
        ...base,
        outcome: 'replayed',
        attemptId: outcome.attemptId,
        ...(outcome.taskId !== undefined && { taskId: outcome.taskId }),
        message:
          'Idempotent retry — the attempt already settled with this terminal outcome (no new side effect).',
      };
    case 'rejected_validation':
      return {
        ...base,
        outcome: 'rejected_validation',
        attemptId: outcome.attemptId,
        ...(outcome.errors !== undefined && { errors: outcome.errors }),
        message:
          'Validation failed — an UNCHANGED retry with this attemptKey replays this terminal rejection (no new side effect). To submit CORRECTED input, use a NEW attemptKey (the corrected payload has a different fingerprint and needs its own key).',
      };
    case 'vetoed':
      return {
        ...base,
        outcome: 'vetoed',
        attemptId: outcome.attemptId,
        ...(outcome.veto !== undefined && { veto: outcome.veto }),
        message: 'Publication vetoed by governance — review the veto detail. An UNCHANGED retry with this attemptKey replays this terminal veto (no new side effect). To retry publication, use a NEW attemptKey.',
      };
    case 'rejected_fingerprint':
      return {
        ...base,
        outcome: 'rejected_fingerprint',
        attemptId: outcome.attemptId,
        message:
          'Payload fingerprint mismatch — the corrected payload requires a NEW attemptKey (do not reuse the current one).',
      };
    case 'guard_mismatch':
      return {
        ...base,
        outcome: 'guard_mismatch',
        attemptId: outcome.attemptId,
        ...(outcome.reasons !== undefined && { reasons: outcome.reasons }),
        message:
          'Guard mismatch — retry with the SAME attemptKey (the adapter re-prepares the reservation on the same key).',
      };
    case 'governance_denied':
      return {
        ...base,
        outcome: 'governance_denied',
        attemptId: outcome.attemptId,
        ...(outcome.kind !== undefined && { kind: outcome.kind }),
        ...(outcome.reason !== undefined && { reason: outcome.reason }),
        ...(outcome.interceptorKey !== undefined && { interceptorKey: outcome.interceptorKey }),
        message:
          'Governance denied — retry with the SAME attemptKey after addressing the denial reason.',
      };
    default: {
      // Exhaustiveness guard — should be unreachable while the outcome union
      // stays in sync with PUBLICATION_DOMAIN_OUTCOMES.
      const _exhaustive: never = outcome.outcome;
      void _exhaustive;
      return {
        ...base,
        outcome: outcome.outcome,
        attemptId: outcome.attemptId,
        message: `Publication attempt ${attemptKey} returned outcome "${outcome.outcome}".`,
      };
    }
  }
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function missionPublishTask(
  client: KanbanApiClient,
  args: {
    missionId: string;
    attemptKey?: string;
    title: string;
    description?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    requiredDomain?: string | null;
    requiredCapabilities?: string[];
    estimatedMinutes?: number;
    labels?: string[];
    dependsOn?: string[];
    assignment?: { kind: 'auto' } | { kind: 'targeted'; agentId: string };
    targetedAssignmentDeadline?: string;
  },
) {
  // Idempotent-retry contract: the caller retains the key across an unchanged
  // Publish; the handler backstops an omitted key with a fresh UUID so a
  // first-time publish still gets a stable retry identity.
  const attemptKey =
    typeof args.attemptKey === 'string' && args.attemptKey.length > 0
      ? args.attemptKey
      : randomUUID();

  let outcome: TaskPublicationOutcome;
  try {
    outcome = await client.publishTaskInMission(args.missionId, {
      attemptKey,
      title: args.title,
      ...(args.description !== undefined && { description: args.description }),
      ...(args.priority !== undefined && { priority: args.priority }),
      ...(args.requiredDomain !== undefined && { requiredDomain: args.requiredDomain }),
      ...(args.requiredCapabilities !== undefined && { requiredCapabilities: args.requiredCapabilities }),
      ...(args.estimatedMinutes !== undefined && { estimatedMinutes: args.estimatedMinutes }),
      ...(args.labels !== undefined && { labels: args.labels }),
      ...(args.dependsOn !== undefined && { dependsOn: args.dependsOn }),
      ...(args.assignment !== undefined && { assignment: args.assignment }),
      ...(args.targetedAssignmentDeadline !== undefined && {
        targetedAssignmentDeadline: args.targetedAssignmentDeadline,
      }),
    });
  } catch (err) {
    // The route sends domain outcomes (422 validation / 409 veto / 409
    // fingerprint / 503 guard) as typed JSON bodies — the transport surfaces
    // them as ApiClientError. Parse the body and interpret; do NOT re-throw
    // (these are normal publication results). Non-domain errors (500 from a
    // programming bug, network failure, etc.) propagate as real failures.
    if (err instanceof ApiClientError) {
      const parsed = parsePublicationErrorBody(err);
      if (parsed !== null) {
        outcome = parsed;
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  return interpretPublicationOutcome(outcome, attemptKey);
}

/**
 * T7 Phase 3a — dormant clone-preparation tool (a sibling of
 * {@link MISSION_PUBLISH_TASK_TOOL} that targets the dormant GET route
 * `GET /tasks/:sourceTaskId/clone-preparation`).
 *
 * Why a sibling rather than a replacement:
 *   The clone prepare/edit/publish journey (T7) is landed DORMANT — the
 *   legacy `cloneTask` + `POST /tasks/:id/clone` stay the active
 *   production path until T11 swaps them. This tool ships alongside them,
 *   exercised only by tests (the sole dormancy exerciser). It is NOT
 *   registered in `ALL_TOOLS` / `TASK_ACTIONS` (mirroring how
 *   {@link MISSION_PUBLISH_TASK_TOOL} is also a standalone export not
 *   wired into the dispatch).
 *
 * Provenance:
 *   The MCP client is an HTTP wrapper — the REST route derives
 *   `auditSource:"rest_api"` + `actorType:"agent"` from the authenticated
 *   MCP caller. This tool carries no provenance fields; the GET is a
 *   pure read-only fetch of the allowlisted DTO.
 *
 * See: T7 ticket § "Execution phases" (P3a) + § "Phase 2 carry-over".
 */
export const TASK_PREPARE_CLONE_TOOL: Tool = {
  name: 'task_prepare_clone',
  description:
    'Read the source Task and return an allowlisted clone-preparation DTO ' +
    '(reusable work-definition fields, RESET Subtasks, UNSELECTED dependency ' +
    'suggestions, source references, default target Mission). Pure read — ' +
    'opening the clone form creates nothing. Dormant (dormant until T11 — ' +
    'prefer the existing `clone_task` MCP tool until the cutover). Edit the ' +
    'returned fields and publish via `task_publish_clone`.',
  inputSchema: {
    type: 'object',
    properties: {
      sourceTaskId: {
        type: 'string',
        description: 'Source Task ID to clone from (read-only).',
      },
    },
    required: ['sourceTaskId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function taskPrepareClone(
  client: KanbanApiClient,
  args: { sourceTaskId: string },
): Promise<ClonePreparation & { message: string }> {
  // The GET is read-only; the route returns 404 for a missing source and
  // 403 for cross-habitat reads. Both surface as ApiClientError — let them
  // propagate (they are real failures, not domain outcomes).
  const preparation = await client.getClonePreparation(args.sourceTaskId);
  return {
    ...preparation,
    message:
      'Source task prefilled for clone — editable work-definition fields, RESET Subtasks, ' +
      'and dependency suggestions returned. Edit the fields you want to change and publish ' +
      'via task_publish_clone.',
  };
}

/**
 * T7 Phase 3a — dormant clone-publication tool (a sibling of
 * {@link MISSION_PUBLISH_TASK_TOOL} that targets the dormant POST route
 * `POST /tasks/:sourceTaskId/clone-publications`).
 *
 * Why a sibling rather than a replacement:
 *   The kernel's shared publication contract (T5) is landed DORMANT — the
 *   legacy `cloneTask` + `POST /tasks/:id/clone` stay the active
 *   production path until T11 swaps them. This tool ships alongside them,
 *   exercised only by tests (the sole dormancy exerciser). It is NOT
 *   registered in `ALL_TOOLS` / `TASK_ACTIONS` (mirroring how
 *   {@link MISSION_PUBLISH_TASK_TOOL} is also a standalone export not
 *   wired into the dispatch).
 *
 * Provenance:
 *   The MCP client is an HTTP wrapper — the REST route derives
 *   `auditSource:"rest_api"` + `actorType:"agent"` from the authenticated
 *   MCP caller. This tool MUST NOT assert `auditSource` in its input (the
 *   body is untrusted; an LLM client could spoof `"mcp_tool"` to mask its
 *   tracks). A future trusted `"mcp_tool"` distinction requires a
 *   server-side header + a route read (post-cutover hardening).
 *
 * Idempotent retry contract:
 *   Mirrors {@link missionPublishTask}: `attemptKey` is the client-supplied
 *   attempt identity. The handler generates a UUID when the caller omits
 *   one and ALWAYS returns the `attemptKey` used in the result so the LLM
 *   can retry an unchanged publication with the same key (the adapter
 *   reserves/replays off the key). Editing a known terminal rejection
 *   uses a NEW key; unchanged retry keeps the old key.
 *
 * Outcome interpretation:
 *   The handler does NOT throw for domain outcomes — validation/veto/
 *   recovering/replay are normal publication results, not errors. The route
 *   forwards 422/409/503 bodies verbatim; the handler parses them out of
 *   the {@link ApiClientError} and returns a clear LLM-facing result
 *   object with a `message` field explaining the next action (retry same
 *   key / new key / poll the attempt). This reuses the same helpers
 *   defined for {@link missionPublishTask} above — the interpretation
 *   table is identical across all dormant publication tools.
 *
 * See: T7 ticket § "Execution phases" (P3a) + § "Phase 2 carry-over".
 */
export const TASK_PUBLISH_CLONE_TOOL: Tool = {
  name: 'task_publish_clone',
  description:
    'Publish a clone of a source Task via the shared publication contract (dormant — ' +
    'prefer the existing `clone_task` MCP tool until the T11 cutover). Idempotent: pass ' +
    'the same attemptKey to retry an unchanged publish; use a new attemptKey only when ' +
    'changing a rejected payload. Returns a clear result object ' +
    '(created/recovering/replayed/rejected_validation/vetoed/rejected_fingerprint/guard_mismatch/governance_denied) ' +
    'with the attemptKey used.',
  inputSchema: {
    type: 'object',
    properties: {
      sourceTaskId: {
        type: 'string',
        description: 'Source Task ID being cloned (the path param of the publication route).',
      },
      attemptKey: {
        type: 'string',
        description:
          'Client-supplied attempt identity for idempotent retry. Retain across unchanged ' +
          'publishes; use a new key only when changing a previously-rejected payload. Omit to ' +
          'have the handler generate a UUID.',
      },
      title: {
        type: 'string',
        description: 'Edited task title',
      },
      description: {
        type: 'string',
        description: 'Edited task description',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Edited task priority',
      },
      requiredDomain: {
        type: 'string',
        description: 'Edited required-domain filter (frontend, backend, devops, testing, fullstack)',
      },
      requiredCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Edited required capabilities (e.g., ["typescript", "react"])',
      },
      estimatedMinutes: {
        type: 'number',
        description: 'Edited estimated time in minutes',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Edited labels',
      },
      subtasks: {
        type: 'array',
        description:
          'Edited Subtasks (add/remove/reorder/edit-titles). The kernel re-allocates ' +
          'fresh IDs + execution state at publication.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            order: { type: 'number' },
            assigneeId: { type: 'string' },
          },
          required: ['title'],
        },
      },
      selectedDependencies: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Task UUIDs this clone should depend on — the EXPLICIT selections from the ' +
          'UNSELECTED suggestions surfaced by `task_prepare_clone`. The kernel revalidates ' +
          'the final dependency graph at publication.',
      },
      targetMissionId: {
        type: 'string',
        description:
          'Target Mission ID (must be an active Mission in the source Habitat; the kernel ' +
          'enforces same-Habitat via cross_habitat_mission).',
      },
      assignment: {
        type: 'object',
        description:
          "Assignment intent (defaults to {kind:'auto'}). For targeted, supply {kind:'targeted', agentId} AND targetedAssignmentDeadline.",
        properties: {
          kind: { type: 'string', enum: ['auto', 'targeted'] },
          agentId: {
            type: 'string',
            description: 'Target agent UUID (required when kind === "targeted")',
          },
        },
        required: ['kind'],
      },
      targetedAssignmentDeadline: {
        type: 'string',
        description:
          'ISO 8601 timestamp; REQUIRED when assignment.kind === "targeted" (the adapter reserves the seat until this deadline).',
      },
    },
    required: ['sourceTaskId', 'title', 'targetMissionId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function taskPublishClone(
  client: KanbanApiClient,
  args: {
    sourceTaskId: string;
    attemptKey?: string;
    title: string;
    description?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    requiredDomain?: string | null;
    requiredCapabilities?: string[];
    estimatedMinutes?: number;
    labels?: string[];
    subtasks?: { title: string; order?: number; assigneeId?: string | null }[];
    selectedDependencies?: string[];
    targetMissionId: string;
    assignment?: { kind: 'auto' } | { kind: 'targeted'; agentId: string };
    targetedAssignmentDeadline?: string;
  },
) {
  // Idempotent-retry contract: same shape as missionPublishTask — the
  // caller retains the key across an unchanged publish; the handler
  // backstops an omitted key with a fresh UUID so a first-time publish
  // still gets a stable retry identity.
  const attemptKey =
    typeof args.attemptKey === 'string' && args.attemptKey.length > 0
      ? args.attemptKey
      : randomUUID();

  let outcome: TaskPublicationOutcome;
  try {
    outcome = await client.publishTaskClone(args.sourceTaskId, {
      attemptKey,
      title: args.title,
      ...(args.description !== undefined && { description: args.description }),
      ...(args.priority !== undefined && { priority: args.priority }),
      ...(args.requiredDomain !== undefined && { requiredDomain: args.requiredDomain }),
      ...(args.requiredCapabilities !== undefined && {
        requiredCapabilities: args.requiredCapabilities,
      }),
      ...(args.estimatedMinutes !== undefined && { estimatedMinutes: args.estimatedMinutes }),
      ...(args.labels !== undefined && { labels: args.labels }),
      ...(args.subtasks !== undefined && { subtasks: args.subtasks }),
      ...(args.selectedDependencies !== undefined && {
        selectedDependencies: args.selectedDependencies,
      }),
      targetMissionId: args.targetMissionId,
      ...(args.assignment !== undefined && { assignment: args.assignment }),
      ...(args.targetedAssignmentDeadline !== undefined && {
        targetedAssignmentDeadline: args.targetedAssignmentDeadline,
      }),
    });
  } catch (err) {
    // Mirror the T6 P3a recovery path: the route sends domain outcomes
    // (422 validation / 409 veto / 409 fingerprint / 503 guard) as typed
    // JSON bodies — the transport surfaces them as ApiClientError. Parse
    // the body and interpret; do NOT re-throw (these are normal
    // publication results). Non-domain errors (500 from a programming
    // bug, network failure, etc.) propagate as real failures.
    if (err instanceof ApiClientError) {
      const parsed = parsePublicationErrorBody(err);
      if (parsed !== null) {
        outcome = parsed;
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  return interpretPublicationOutcome(outcome, attemptKey);
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const MISSION_GET_CONTEXT_TOOL: Tool = {
  name: 'mission_get_context',
  description:
    'Get full mission context including description, acceptance criteria, all task statuses, and completed task results. ' +
    'Use this to understand the mission before claiming a task.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Mission ID',
      },
    },
    required: ['missionId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function missionGetContext(
  client: KanbanApiClient,
  args: { missionId: string }
) {
  return client.getMissionContext(args.missionId);
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const HABITAT_DELETE_MISSION_TOOL: Tool = {
  name: 'habitat_delete_mission',
  description:
    'Delete a mission and all its tasks. This action is permanent and cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Mission ID to delete',
      },
    },
    required: ['missionId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function habitatDeleteMission(
  client: KanbanApiClient,
  args: { missionId: string }
) {
  await client.deleteMission(args.missionId);
  return { success: true, missionId: args.missionId, message: `Mission ${args.missionId} deleted` };
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const HABITAT_LIST_ARCHIVED_MISSIONS_TOOL: Tool = {
  name: 'habitat_list_archived_missions',
  description:
    'List all archived missions in a habitat. Archived missions are completed work items that are hidden from the main habitat.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'Habitat ID',
      },
    },
    required: ['boardId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function habitatListArchivedMissions(
  client: KanbanApiClient,
  args: { boardId: string }
) {
  return client.listMissions(args.boardId, {
    isArchived: true,
  });
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const MISSION_ARCHIVE_TOOL: Tool = {
  name: 'mission_archive',
  description:
    'Archive a completed mission. This removes it from the main habitat while keeping its metrics intact. Mission must have status=done.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Mission ID to archive',
      },
    },
    required: ['missionId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function missionArchive(
  client: KanbanApiClient,
  args: { missionId: string }
) {
  const result = await client.archiveMission(args.missionId);
  return { success: true, mission: result.mission };
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const MISSION_UNARCHIVE_TOOL: Tool = {
  name: 'mission_unarchive',
  description:
    'Unarchive a previously archived mission. This returns it to the main habitat in the done column.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Mission ID to unarchive',
      },
    },
    required: ['missionId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function missionUnarchive(
  client: KanbanApiClient,
  args: { missionId: string }
) {
  const result = await client.unarchiveMission(args.missionId);
  return { success: true, mission: result.mission };
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const MISSION_GET_COMMENTS_TOOL: Tool = {
  name: 'mission_get_comments',
  description:
    'Get comments on a mission, sorted newest first. ' +
    'Use this to read discussion, feedback, or conversation history about the mission as a whole.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Mission ID',
      },
      limit: {
        type: 'number',
        description: 'Maximum comments to return (default 50, max 100)',
        minimum: 1,
        maximum: 100,
      },
      offset: {
        type: 'number',
        description: 'Number of comments to skip (for pagination)',
        minimum: 0,
      },
    },
    required: ['missionId'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function missionGetComments(
  client: KanbanApiClient,
  args: { missionId: string; limit?: number; offset?: number }
) {
  return client.getMissionComments(args.missionId, {
    limit: args.limit ?? 50,
    offset: args.offset ?? 0,
  });
}

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export const MISSION_ADD_COMMENT_TOOL: Tool = {
  name: 'mission_add_comment',
  description:
    'Add a comment to a mission. Use this to discuss scope, design decisions, or provide feedback at the mission level.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'Mission ID',
      },
      content: {
        type: 'string',
        description: 'Comment text (1-5000 characters)',
        minLength: 1,
        maxLength: 5000,
      },
      parentId: {
        type: 'string',
        description: 'Optional UUID of the parent comment to reply to',
      },
    },
    required: ['missionId', 'content'],
  },
};

/**
 * @requires MissionClient
 * @requires CommentClient
 */
export async function missionAddComment(
  client: KanbanApiClient,
  args: { missionId: string; content: string; parentId?: string }
) {
  return client.addMissionComment(args.missionId, args.content, args.parentId);
}
