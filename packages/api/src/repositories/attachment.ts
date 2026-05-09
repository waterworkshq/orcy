import { getDb } from '../db/index.js';
import { taskAttachments } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

import { v4 as uuid } from 'uuid';
import * as fileStorage from '../services/fileStorage.js';

export interface Attachment {
  id: string;
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
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

  db.insert(taskAttachments).values({
    id,
    taskId: input.taskId,
    filename: input.filename,
    originalName: input.originalName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    uploadedBy: input.uploadedBy ?? null,
    createdAt: now,
  }).run();

  return getAttachmentById(id)!;
}

export function getAttachmentsByTaskId(taskId: string): Attachment[] {
  const db = getDb();
  return db.select().from(taskAttachments)
    .where(eq(taskAttachments.taskId, taskId))
    .orderBy(sql`${taskAttachments.createdAt} DESC`)
    .all() as Attachment[];
}

export function getAttachmentById(id: string): Attachment | null {
  const db = getDb();
  const rows = db.select().from(taskAttachments).where(eq(taskAttachments.id, id)).all();
  return rows.length > 0 ? rows[0] as Attachment : null;
}

export function deleteAttachment(id: string): boolean {
  const attachment = getAttachmentById(id);
  if (!attachment) return false;

  fileStorage.deleteFile(attachment.filename);
  const db = getDb();
  db.delete(taskAttachments).where(eq(taskAttachments.id, id)).run();
  return true;
}
