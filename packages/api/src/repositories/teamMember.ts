import { getDb } from '../db/index.js';
import { teamMembers, habitats } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export type TeamMemberRole = 'owner' | 'admin' | 'member';

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  joinedAt: string;
}

export function addMember(input: { teamId: string; userId: string; role?: TeamMemberRole }): TeamMember {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  const role = input.role ?? 'member';

  db.insert(teamMembers).values({
    id,
    teamId: input.teamId,
    userId: input.userId,
    role,
    joinedAt: now,
  }).run();

  return { id, teamId: input.teamId, userId: input.userId, role, joinedAt: now };
}

export function removeMember(teamId: string, userId: string): void {
  const db = getDb();
  db.delete(teamMembers).where(
    and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))
  ).run();
}

export function updateMemberRole(teamId: string, userId: string, role: TeamMemberRole): TeamMember | null {
  const db = getDb();
  db.update(teamMembers).set({ role }).where(
    and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))
  ).run();

  return getMember(teamId, userId);
}

export function listMembers(teamId: string): TeamMember[] {
  const db = getDb();
  return db.select().from(teamMembers)
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(teamMembers.joinedAt)
    .all() as TeamMember[];
}

export function getMember(teamId: string, userId: string): TeamMember | null {
  const db = getDb();
  const rows = db.select().from(teamMembers).where(
    and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))
  ).all();
  return rows.length > 0 ? rows[0] as TeamMember : null;
}

export function isTeamMember(teamId: string, userId: string): boolean {
  return getMember(teamId, userId) !== null;
}

export function isTeamMemberByHabitatId(habitatId: string, userId: string): boolean {
  const db = getDb();
  const rows = db.select({
    one: habitats.id,
  }).from(teamMembers)
    .innerJoin(habitats, eq(habitats.teamId, teamMembers.teamId))
    .where(
      and(eq(habitats.id, habitatId), eq(teamMembers.userId, userId))
    ).all();
  return rows.length > 0;
}
