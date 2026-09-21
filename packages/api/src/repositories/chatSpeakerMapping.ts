import { getDb } from "../db/index.js";
import { chatSpeakerMappings } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { repositoryCreateError, repositoryDeleteError } from "../errors/repository.js";
import { getIntegrationById, type ChatIntegration } from "./chatIntegration.js";

export interface ChatSpeakerMapping {
  id: string;
  habitatId: string;
  integrationId: string;
  provider: "slack" | "discord";
  providerWorkspaceId: string;
  providerSpeakerId: string;
  localUserId: string;
  createdBy: string;
  createdAt: string;
}

function rowToMapping(row: typeof chatSpeakerMappings.$inferSelect): ChatSpeakerMapping {
  return row as ChatSpeakerMapping;
}

/** Lists a habitat's speaker mappings (admin surface; contains no secrets — none exist on this table). */
export function getMappingsByHabitat(habitatId: string): ChatSpeakerMapping[] {
  const db = getDb();
  return db
    .select()
    .from(chatSpeakerMappings)
    .where(eq(chatSpeakerMappings.habitatId, habitatId))
    .all()
    .map(rowToMapping);
}

/** Lists a single integration's speaker mappings (admin surface). */
export function getMappingsByIntegration(integrationId: string): ChatSpeakerMapping[] {
  const db = getDb();
  return db
    .select()
    .from(chatSpeakerMappings)
    .where(eq(chatSpeakerMappings.integrationId, integrationId))
    .all()
    .map(rowToMapping);
}

/** Exact-composite decision lookup: one integration row's mapping for one workspace-scoped speaker. */
export function getMapping(
  integrationId: string,
  providerWorkspaceId: string,
  providerSpeakerId: string,
): ChatSpeakerMapping | null {
  const db = getDb();
  const rows = db
    .select()
    .from(chatSpeakerMappings)
    .where(
      and(
        eq(chatSpeakerMappings.integrationId, integrationId),
        eq(chatSpeakerMappings.providerWorkspaceId, providerWorkspaceId),
        eq(chatSpeakerMappings.providerSpeakerId, providerSpeakerId),
      ),
    )
    .all();
  return rows.length > 0 ? rowToMapping(rows[0]) : null;
}

/**
 * Creates a speaker mapping. The habitat is DERIVED from the integration row
 * (never the request) so a mapping cannot live in a foreign habitat; the
 * composite UNIQUE(integration, workspace, speaker) rejects a duplicate
 * speaker mapping with a repository create error the route maps to 409.
 */
export function createMapping(input: {
  integrationId: string;
  providerWorkspaceId: string;
  providerSpeakerId: string;
  localUserId: string;
  createdBy: string;
}): ChatSpeakerMapping {
  const integration: ChatIntegration | null = getIntegrationById(input.integrationId);
  if (!integration) {
    throw repositoryCreateError(
      "chatSpeakerMapping",
      new Error(`integration not found: ${input.integrationId}`),
      input.integrationId,
    );
  }

  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(chatSpeakerMappings)
      .values({
        id,
        habitatId: integration.habitatId,
        integrationId: input.integrationId,
        provider: integration.provider,
        providerWorkspaceId: input.providerWorkspaceId,
        providerSpeakerId: input.providerSpeakerId,
        localUserId: input.localUserId,
        createdBy: input.createdBy,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("chatSpeakerMapping", err as Error, id);
  }

  const created = db.select().from(chatSpeakerMappings).where(eq(chatSpeakerMappings.id, id)).all();
  if (created.length === 0) {
    throw repositoryCreateError("chatSpeakerMapping", new Error("row missing after insert"), id);
  }
  return rowToMapping(created[0]);
}

export function deleteMapping(id: string): boolean {
  const db = getDb();
  const existing = db
    .select()
    .from(chatSpeakerMappings)
    .where(eq(chatSpeakerMappings.id, id))
    .all();
  if (existing.length === 0) return false;
  try {
    db.delete(chatSpeakerMappings).where(eq(chatSpeakerMappings.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("chatSpeakerMapping", err as Error, id);
  }
  return true;
}
