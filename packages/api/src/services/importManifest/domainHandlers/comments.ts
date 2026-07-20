/**
 * comments domain handler — Mission comments (free-form text on Tasks).
 *
 * # Validation rules (accumulate, never first-error)
 *
 *   - Per-comment shape: `sourceId`, `taskSourceId`, `content`, `author`,
 *     `authorType`, `authoredAt` are well-formed.
 *   - `taskSourceId` is a non-empty string (the reference SHAPE; resolution
 *     against the tasks domain happens in resolveReferences via the idMap).
 *   - `parentCommentSourceId`, when present, is a non-empty string (same —
 *     resolution within the comments domain happens in resolveReferences).
 *   - `author.resolvedActorId` is `string | null`.
 *   - `author.importedAttribution` is a non-empty string.
 *   - `authorType` ∈ {human, agent, remote_human, remote_orcy}.
 *
 * # prepare
 *
 * Allocates one prospective server ID per comment into the idMap.
 *
 * # resolveReferences
 *
 * Rewrites each comment's `taskSourceId` → the task's server ID (from the
 * idMap, populated by the tasks handler's prepare) and `parentCommentSourceId`
 * → the parent comment's server ID (from the idMap, populated by THIS
 * handler's prepare). Accumulates unresolved-reference errors.
 *
 * @see packages/api/src/services/importManifest/types.ts for CommentPortable.
 */
import type { CommentPortable, DomainEnvelope } from "../types.js";
import type {
  DomainError,
  DomainHandler,
  DomainValidationResult,
  IdentityMap,
  ManifestContext,
  ReferenceResolution,
} from "../domainHandler.js";
import {
  allocateServerId,
  domainError,
  resolutionErr,
  resolutionOk,
  validationErr,
  validationOk,
} from "../domainHandler.js";

// ---------------------------------------------------------------------------
// Validated + prepared shapes
// ---------------------------------------------------------------------------

const AUTHOR_TYPES = new Set(["human", "agent", "remote_human", "remote_orcy"]);

export interface ValidatedComment {
  sourceId: string;
  taskSourceId: string;
  parentCommentSourceId: string | null;
  content: string;
  author: { resolvedActorId: string | null; importedAttribution: string };
  authorType: CommentPortable["authorType"];
  authoredAt: string;
}

export interface ValidatedComments {
  comments: ValidatedComment[];
}

export interface PreparedComment {
  sourceId: string;
  /** The prospective server-side comment id (allocated in prepare). */
  commentServerId: string;
  /** The source Task's sourceId (rewritten to a server id in resolveReferences). */
  taskSourceId: string;
  /** The resolved Task server id (null until resolveReferences runs). */
  taskServerId: string | null;
  /** The source parent-comment's sourceId (rewritten in resolveReferences). */
  parentCommentSourceId: string | null;
  /** The resolved parent-comment server id (null when parentCommentSourceId is null
   *  OR before resolveReferences runs). */
  parentCommentServerId: string | null;
  content: string;
  author: { resolvedActorId: string | null; importedAttribution: string };
  authorType: CommentPortable["authorType"];
  authoredAt: string;
}

export interface PreparedComments {
  comments: PreparedComment[];
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export function validateComments(
  envelope: DomainEnvelope<unknown>,
  _ctx: ManifestContext,
  _idMap: IdentityMap,
): DomainValidationResult<ValidatedComments> {
  const errors: DomainError[] = [];
  const raw = envelope.data;

  if (!Array.isArray(raw)) {
    return validationErr([
      domainError("comments", "invalid_envelope_data", "comments envelope data must be an array", {
        actual: typeof raw,
      }),
    ]);
  }

  const validated: ValidatedComment[] = [];

  raw.forEach((entry, i) => {
    const fieldPathBase: readonly (string | number)[] = ["comments", i];
    const errs: DomainError[] = [];

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        domainError("comments", "invalid_comment_shape", `comments[${i}] must be a plain object`, {
          actual: entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry,
          fieldPath: fieldPathBase,
        }),
      );
      return;
    }

    const e = entry as Record<string, unknown>;

    if (typeof e.sourceId !== "string" || e.sourceId.length === 0) {
      errs.push(
        domainError(
          "comments",
          "invalid_source_id",
          `comments[${i}].sourceId must be a non-empty string`,
          { actual: typeof e.sourceId, fieldPath: [...fieldPathBase, "sourceId"] },
        ),
      );
    }

    if (typeof e.taskSourceId !== "string" || e.taskSourceId.length === 0) {
      errs.push(
        domainError(
          "comments",
          "invalid_task_source_id",
          `comments[${i}].taskSourceId must be a non-empty string`,
          { actual: typeof e.taskSourceId, fieldPath: [...fieldPathBase, "taskSourceId"] },
        ),
      );
    }

    if (
      e.parentCommentSourceId !== null &&
      (typeof e.parentCommentSourceId !== "string" ||
        (e.parentCommentSourceId as string).length === 0)
    ) {
      errs.push(
        domainError(
          "comments",
          "invalid_parent_comment_source_id",
          `comments[${i}].parentCommentSourceId must be a non-empty string or null`,
          {
            actual: typeof e.parentCommentSourceId,
            fieldPath: [...fieldPathBase, "parentCommentSourceId"],
          },
        ),
      );
    }

    if (typeof e.content !== "string") {
      errs.push(
        domainError("comments", "invalid_content", `comments[${i}].content must be a string`, {
          actual: typeof e.content,
          fieldPath: [...fieldPathBase, "content"],
        }),
      );
    }

    // author shape
    const author = e.author;
    if (author === null || typeof author !== "object" || Array.isArray(author)) {
      errs.push(
        domainError(
          "comments",
          "invalid_author_shape",
          `comments[${i}].author must be a plain object`,
          {
            actual: author === null ? "null" : Array.isArray(author) ? "array" : typeof author,
            fieldPath: [...fieldPathBase, "author"],
          },
        ),
      );
    } else {
      const a = author as Record<string, unknown>;
      if (a.resolvedActorId !== null && typeof a.resolvedActorId !== "string") {
        errs.push(
          domainError(
            "comments",
            "invalid_resolved_actor_id",
            `comments[${i}].author.resolvedActorId must be a string or null`,
            {
              actual: typeof a.resolvedActorId,
              fieldPath: [...fieldPathBase, "author", "resolvedActorId"],
            },
          ),
        );
      }
      if (
        typeof a.importedAttribution !== "string" ||
        (a.importedAttribution as string).length === 0
      ) {
        errs.push(
          domainError(
            "comments",
            "invalid_imported_attribution",
            `comments[${i}].author.importedAttribution must be a non-empty string`,
            {
              actual: typeof a.importedAttribution,
              fieldPath: [...fieldPathBase, "author", "importedAttribution"],
            },
          ),
        );
      }
    }

    if (typeof e.authorType !== "string" || !AUTHOR_TYPES.has(e.authorType)) {
      errs.push(
        domainError(
          "comments",
          "invalid_author_type",
          `comments[${i}].authorType must be one of human | agent | remote_human | remote_orcy`,
          {
            actual: e.authorType,
            expected: "human | agent | remote_human | remote_orcy",
            fieldPath: [...fieldPathBase, "authorType"],
          },
        ),
      );
    }

    if (typeof e.authoredAt !== "string" || (e.authoredAt as string).length === 0) {
      errs.push(
        domainError(
          "comments",
          "invalid_authored_at",
          `comments[${i}].authoredAt must be a non-empty string (ISO timestamp)`,
          { actual: typeof e.authoredAt, fieldPath: [...fieldPathBase, "authoredAt"] },
        ),
      );
    }

    if (errs.length > 0) {
      errors.push(...errs);
      return;
    }

    validated.push({
      sourceId: e.sourceId as string,
      taskSourceId: e.taskSourceId as string,
      parentCommentSourceId: (e.parentCommentSourceId ?? null) as string | null,
      content: e.content as string,
      author: {
        resolvedActorId: ((author as Record<string, unknown>).resolvedActorId ?? null) as
          | string
          | null,
        importedAttribution: (author as Record<string, unknown>).importedAttribution as string,
      },
      authorType: e.authorType as CommentPortable["authorType"],
      authoredAt: e.authoredAt as string,
    });
  });

  if (errors.length > 0) return validationErr(errors);
  return validationOk({ comments: validated });
}

// ---------------------------------------------------------------------------
// Prepare (PURE — no DB writes)
// ---------------------------------------------------------------------------

export function prepareComments(
  validated: ValidatedComments,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): PreparedComments {
  const comments: PreparedComment[] = validated.comments.map((c) => {
    const commentServerId = allocateServerId(idMap, c.sourceId);
    return {
      sourceId: c.sourceId,
      commentServerId,
      taskSourceId: c.taskSourceId,
      taskServerId: null,
      parentCommentSourceId: c.parentCommentSourceId,
      parentCommentServerId: null,
      content: c.content,
      author: c.author,
      authorType: c.authorType,
      authoredAt: c.authoredAt,
    };
  });
  return { comments };
}

// ---------------------------------------------------------------------------
// Resolve references (PURE — rewrite taskSourceId + parentCommentSourceId)
// ---------------------------------------------------------------------------

export function resolveCommentsReferences(
  prepared: PreparedComments,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): ReferenceResolution<PreparedComments> {
  const errors: DomainError[] = [];
  const resolvedComments: PreparedComment[] = prepared.comments.map((c) => {
    const taskServerId = idMap.sourceToServer.get(c.taskSourceId);
    if (taskServerId === undefined) {
      errors.push(
        domainError(
          "comments",
          "unresolved_task_source_id",
          `comment '${c.sourceId}' references unknown taskSourceId '${c.taskSourceId}'`,
          { sourceId: c.sourceId, actual: c.taskSourceId },
        ),
      );
    }

    let parentCommentServerId: string | null = null;
    if (c.parentCommentSourceId !== null) {
      const resolved = idMap.sourceToServer.get(c.parentCommentSourceId);
      if (resolved === undefined) {
        errors.push(
          domainError(
            "comments",
            "unresolved_parent_comment_source_id",
            `comment '${c.sourceId}' references unknown parentCommentSourceId '${c.parentCommentSourceId}'`,
            { sourceId: c.sourceId, actual: c.parentCommentSourceId },
          ),
        );
      } else {
        parentCommentServerId = resolved;
      }
    }

    return {
      ...c,
      taskServerId: taskServerId ?? null,
      parentCommentServerId,
    };
  });

  if (errors.length > 0) return resolutionErr(errors);
  return resolutionOk({ comments: resolvedComments });
}

// ---------------------------------------------------------------------------
// The handler object
// ---------------------------------------------------------------------------

export const commentsHandler: DomainHandler<ValidatedComments, PreparedComments> = {
  domainName: "comments",
  validate: validateComments,
  prepare: prepareComments,
  resolveReferences: resolveCommentsReferences,
};
