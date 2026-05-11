import { getDb } from '../db/index.js';
import { teams, teamMembers } from '../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export interface Team {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export function createTeam(input: { organizationId: string; name: string; slug: string }): Team {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(teams).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    slug: input.slug,
    createdAt: now,
  }).run();

  return getTeamById(id)!;
}

export function getTeamById(id: string): Team | null {
  const db = getDb();
  const rows = db.select().from(teams).where(eq(teams.id, id)).all();
  return rows.length > 0 ? rows[0] as Team : null;
}

export function listTeamsByOrganization(organizationId: string): Team[] {
  const db = getDb();
  return db.select().from(teams)
    .where(eq(teams.organizationId, organizationId))
    .orderBy(sql`${teams.createdAt} DESC`)
    .all() as Team[];
}

export function listTeamsByUserId(userId: string): Team[] {
  const db = getDb();
  return db.select({
    id: teams.id,
    organizationId: teams.organizationId,
    name: teams.name,
    slug: teams.slug,
    createdAt: teams.createdAt,
  }).from(teams)
    .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(sql`${teams.createdAt} DESC`)
    .all() as Team[];
}

export function deleteTeam(id: string): void {
  const db = getDb();
  db.delete(teams).where(eq(teams.id, id)).run();
}
