import { getDb } from '../db/index.js';
import { teamMembers, habitats } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getHabitatById } from './habitat.js';

export type TeamMemberRole = 'owner' | 'admin' | 'member';

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  joinedAt: string;
}

export function addMember(input: { teamId: string; userId: string; role?: TeamMemberRole }, db = getDb()): TeamMember {
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

export function removeMember(teamId: string, userId: string, db = getDb()): void {
  db.delete(teamMembers).where(
    and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))
  ).run();
}

export function updateMemberRole(teamId: string, userId: string, role: TeamMemberRole, db = getDb()): TeamMember | null {
  db.update(teamMembers).set({ role }).where(
    and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))
  ).run();

  return getMember(teamId, userId, db);
}

export function listMembers(teamId: string): TeamMember[] {
  const db = getDb();
  return db.select().from(teamMembers)
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(teamMembers.joinedAt)
    .all() as TeamMember[];
}

export function getMember(teamId: string, userId: string, db = getDb()): TeamMember | null {
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

/**
 * The human admission rule backing the `request.user` branch of
 * `checkHabitatAccess` (middleware/realtimeAuth.ts), exported so outbound
 * habitat-content channels (task notification email) enforce the SAME rule
 * as the read surface instead of a competing policy. Personal habitats (no
 * team) admit any authenticated human; team habitats require CURRENT team
 * membership — a deployment-wide admin role alone grants no admission. A
 * missing habitat admits nobody (fail closed).
 *
 * Single-user projection of {@link humansWithHabitatAccess} — the policy is
 * implemented exactly once, there.
 */
export function humanCanAccessHabitat(habitatId: string, userId: string): boolean {
  return humansWithHabitatAccess(habitatId, [userId]).has(userId);
}

/**
 * Batch arity of {@link humanCanAccessHabitat} for recipient fan-out (task
 * notification email). Loads the habitat once, then reads the habitat
 * team's current member ids with a single habitat-keyed query whose only
 * bound value is the habitat id — no recipient-count-bound parameters, so
 * the candidate-set size has no SQLite host-parameter ceiling — and returns
 * the stdlib Set intersection with the candidates. Same admission policy as
 * {@link humanCanAccessHabitat}: missing habitat admits nobody, personal
 * habitats admit every candidate, team habitats admit only current members;
 * an empty candidate set runs no query.
 */
export function humansWithHabitatAccess(habitatId: string, userIds: readonly string[]): Set<string> {
  if (userIds.length === 0) return new Set();
  const habitat = getHabitatById(habitatId);
  if (!habitat) return new Set();
  const candidates = new Set(userIds);
  if (!habitat.teamId) return candidates;
  const db = getDb();
  const rows = db.select({ userId: teamMembers.userId }).from(teamMembers)
    .innerJoin(habitats, eq(habitats.teamId, teamMembers.teamId))
    .where(eq(habitats.id, habitatId))
    .all() as Array<{ userId: string }>;
  const members = new Set(rows.map((row) => row.userId));
  return new Set([...members].filter((userId) => candidates.has(userId)));
}
