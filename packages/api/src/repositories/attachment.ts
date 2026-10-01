import type { FastifyRequest } from "fastify";
import { getDb } from "../db/index.js";
import {
  taskAttachments,
  tasks,
  missions,
  habitats,
  agents,
  teamMembers,
} from "../db/schema/index.js";
import { eq, sql, and, isNull } from "drizzle-orm";

import { v4 as uuid } from "uuid";
import * as fileStorage from "../services/fileStorage.js";
import { repositoryCreateError, assertFound, repositoryDeleteError } from "../errors/repository.js";
import { badRequest, unauthorized, forbidden, notFound, conflict, isAppError } from "../errors.js";
import { hashApiKey } from "./agent.js";

export interface Attachment {
  id: string;
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  /**
   * Nullable persisted storage: `task_attachments.created_at` has a default
   * but no NOT NULL constraint, so storage permits (and drift tests inject)
   * null. Compared null-aware and bound with `IS NULL` in the conditional
   * DELETE — never cast back to `string`.
   */
  createdAt: string | null;
}

export function createAttachment(input: {
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy?: string | null;
}): Attachment {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(taskAttachments)
      .values({
        id,
        taskId: input.taskId,
        filename: input.filename,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        uploadedBy: input.uploadedBy ?? null,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("attachment", err as Error, id);
  }

  return assertFound(getAttachmentById(id), "attachment", id);
}

export function getAttachmentsByTaskId(taskId: string): Attachment[] {
  const db = getDb();
  return db
    .select()
    .from(taskAttachments)
    .where(eq(taskAttachments.taskId, taskId))
    .orderBy(sql`${taskAttachments.createdAt} DESC`)
    .all();
}

export function getAttachmentById(id: string): Attachment | null {
  const db = getDb();
  const rows = db.select().from(taskAttachments).where(eq(taskAttachments.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Full persisted attachment identity: the eight columns of `task_attachments`.
 * `uploadedBy` and `createdAt` are nullable in storage and compared null-aware.
 */
const ATTACHMENT_IDENTITY_FIELDS = [
  "id",
  "taskId",
  "filename",
  "originalName",
  "mimeType",
  "sizeBytes",
  "uploadedBy",
  "createdAt",
] as const;

/** Exact, null-aware equality of every persisted identity field. */
function sameAttachmentIdentity(a: Attachment, b: Attachment): boolean {
  return ATTACHMENT_IDENTITY_FIELDS.every((field) => a[field] === b[field]);
}

/** Conditional-DELETE predicate binding the full identity, null-aware. */
function attachmentIdentityWhere(a: Attachment) {
  return and(
    eq(taskAttachments.id, a.id),
    eq(taskAttachments.taskId, a.taskId),
    eq(taskAttachments.filename, a.filename),
    eq(taskAttachments.originalName, a.originalName),
    eq(taskAttachments.mimeType, a.mimeType),
    eq(taskAttachments.sizeBytes, a.sizeBytes),
    a.uploadedBy === null
      ? isNull(taskAttachments.uploadedBy)
      : eq(taskAttachments.uploadedBy, a.uploadedBy),
    a.createdAt === null
      ? isNull(taskAttachments.createdAt)
      : eq(taskAttachments.createdAt, a.createdAt),
  );
}

interface CurrentDeleteActor {
  kind: "agent" | "human";
  id: string;
  humanRole?: string;
}

/**
 * Revalidates the served request's actor under the writer reservation.
 *
 * Agent branch: the ACTUAL `x-agent-api-key` header is re-hashed and must map
 * to a persisted row with the SAME agent id the middleware authenticated — a
 * deleted agent or a key reassigned to another agent is a late 401, never a
 * borrowed mapping. Human branch: a nonempty authenticated JWT user id plus
 * its verified-claim role; remote context alone cannot pass. This is an
 * ordinary trusted internal boundary, not an unforgeable capability.
 */
function resolveCurrentDeleteActor(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  request: FastifyRequest<{ Params: { id: string } }>,
): CurrentDeleteActor {
  if (request.agent) {
    const headerKey = request.headers["x-agent-api-key"];
    if (typeof headerKey !== "string" || headerKey.length === 0) {
      throw unauthorized("Invalid API key", "INVALID_API_KEY");
    }
    const hash = hashApiKey(headerKey);
    const rows = tx
      .select({ id: agents.id, apiKey: agents.apiKey })
      .from(agents)
      .where(eq(agents.id, request.agent.id))
      .all();
    if (rows.length !== 1 || rows[0].apiKey !== hash) {
      throw unauthorized("Invalid API key", "INVALID_API_KEY");
    }
    return { kind: "agent", id: rows[0].id };
  }
  const userId = request.user?.id;
  if (typeof userId === "string" && userId.length > 0) {
    return { kind: "human", id: userId, humanRole: request.user!.role };
  }
  throw unauthorized("Authentication required");
}

/**
 * DB-first destructive attachment deletion.
 *
 * One wholly synchronous `BEGIN IMMEDIATE` transaction revalidates current
 * authority (live agent-key mapping, current row → Task → Mission → Habitat,
 * team membership for humans, the unchanged scalar-uploader / assigned-agent /
 * JWT admin-or-editor disjunction), then requires the current row's full
 * eight-field identity to equal the admitted preimage, deletes conditionally
 * on that exact identity with RETURNING verification, and proves the target id
 * is absent on the same client before returning the removed row.
 *
 * Only after the transaction helper returns — commit completed — is the
 * UNCHANGED `fileStorage.deleteFile` called with the removed row's stored
 * filename, outside the repository error wrap so a real filesystem failure
 * surfaces as 500 INTERNAL_ERROR with the row already absent. AppErrors
 * (401/403/404/409) rethrow unwrapped; SQL/commit failures wrap as
 * REPOSITORY_ERROR. No filesystem-DB atomicity, compensation or recovery is
 * claimed: a crash between commit and unlink leaves orphan bytes, and a retry
 * of the same id is 404.
 */
export function deleteAttachment(
  request: FastifyRequest<{ Params: { id: string } }>,
  admitted: Attachment,
): void {
  if (!request || typeof request.params?.id !== "string" || request.params.id === "") {
    throw badRequest("Invalid attachment delete request");
  }
  if (!admitted || typeof admitted !== "object") {
    throw badRequest("Invalid attachment delete request");
  }
  const urlId = request.params.id;

  let removed: Attachment;
  try {
    removed = getDb().transaction(
      (tx) => {
        const actor = resolveCurrentDeleteActor(tx, request);

        const currentRows = tx
          .select()
          .from(taskAttachments)
          .where(eq(taskAttachments.id, urlId))
          .all();
        if (currentRows.length === 0) throw notFound("Attachment not found");
        const current = currentRows[0];

        const taskRows = tx.select().from(tasks).where(eq(tasks.id, current.taskId)).all();
        if (taskRows.length === 0) throw notFound("Task not found");
        const currentTask = taskRows[0];

        const missionRows = tx
          .select()
          .from(missions)
          .where(eq(missions.id, currentTask.missionId))
          .all();
        if (missionRows.length === 0) throw notFound("Mission not found");

        const habitatRows = tx
          .select()
          .from(habitats)
          .where(eq(habitats.id, missionRows[0].habitatId))
          .all();
        if (habitatRows.length === 0) throw notFound("Habitat not found");
        const currentHabitat = habitatRows[0];

        // Human admission on CURRENT facts: a team Habitat requires id
        // membership (role-irrelevant); personal Habitats admit any
        // authenticated human. Agents pass any existing Habitat.
        if (actor.kind === "human" && currentHabitat.teamId) {
          const memberRows = tx
            .select({ teamId: teamMembers.teamId })
            .from(teamMembers)
            .where(
              and(eq(teamMembers.teamId, currentHabitat.teamId), eq(teamMembers.userId, actor.id)),
            )
            .all();
          if (memberRows.length === 0) {
            throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
          }
        }

        // Unchanged delete action disjunction on CURRENT facts. Current
        // authority denial precedes any preimage identity conflict.
        const assignedAgentId = currentTask.assignedAgentId ?? null;
        const allowed =
          (current.uploadedBy !== null && current.uploadedBy === actor.id) ||
          (actor.kind === "agent" && assignedAgentId === actor.id) ||
          (actor.kind === "human" && (actor.humanRole === "admin" || actor.humanRole === "editor"));
        if (!allowed) throw forbidden("Not authorized to delete this attachment");

        // Full preimage identity — including the id itself, so an admitted
        // snapshot whose id differs from the URL id is a 409 before any
        // deletion or filesystem effect. No row version exists; a
        // changed-and-changed-back row is indistinguishable (ABA ceiling).
        if (!sameAttachmentIdentity(current, admitted)) throw conflict("Attachment changed");

        // Conditional DELETE bound to the full identity, RETURNING exactly
        // one row that must equal the identity. Zero rows (RAISE(IGNORE),
        // concurrent removal), unexpected counts or a wrong returned row are
        // 409 with full rollback and no filesystem effect.
        const deleted = tx
          .delete(taskAttachments)
          .where(attachmentIdentityWhere(admitted))
          .returning()
          .all();
        if (deleted.length !== 1 || !sameAttachmentIdentity(deleted[0], admitted)) {
          throw conflict("Attachment changed");
        }

        // Same-transaction absence postcheck at the TARGET id: a trigger that
        // reinserts the id — even with changed fields — fails here and rolls
        // the whole transaction back. Returned rows alone do not prove the
        // winning state.
        const survivors = tx
          .select({ id: taskAttachments.id })
          .from(taskAttachments)
          .where(eq(taskAttachments.id, urlId))
          .all();
        if (survivors.length !== 0) throw conflict("Attachment changed");

        return deleted[0];
      },
      { behavior: "immediate" },
    );
  } catch (err) {
    if (isAppError(err)) throw err;
    throw repositoryDeleteError("attachment", err as Error, urlId);
  }

  // Postcommit only: unchanged helper, removed row's stored name, outside the
  // SQL catch. Missing file is the helper's ordinary no-op; a propagated
  // failure (e.g. EISDIR on a stored directory) is 500 INTERNAL_ERROR with
  // the row already absent — orphan bytes, retry 404, no cleanup.
  fileStorage.deleteFile(removed.filename);
}
