import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as orgRepo from '../repositories/organization.js';
import * as teamRepo from '../repositories/team.js';
import * as memberRepo from '../repositories/teamMember.js';
import * as boardRepo from '../repositories/board.js';
import { users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

let counter = 0;
function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${++counter}`;
}

function ensureUser(userId: string) {
  const db = getDb();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    db.insert(users).values({
      id: userId,
      username: userId,
      passwordHash: 'hash',
      displayName: userId,
      role: 'admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  }
}

describe('Multi-Tenant / Team Support', () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterAll(() => {
    closeDb();
  });

  describe('Organizations', () => {
    it('creates an organization', () => {
      const org = orgRepo.createOrganization({ name: 'Test Org', slug: unique('test-org') });
      expect(org.name).toBe('Test Org');
      expect(org.slug).toContain('test-org');
      expect(org.id).toBeDefined();
    });

    it('gets organization by id', () => {
      const org = orgRepo.createOrganization({ name: 'Acme', slug: unique('acme') });
      const found = orgRepo.getOrganizationById(org.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Acme');
    });

    it('gets organization by slug', () => {
      const slug = unique('globex');
      orgRepo.createOrganization({ name: 'Globex', slug });
      const found = orgRepo.getOrganizationBySlug(slug);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Globex');
    });

    it('lists organizations', () => {
      orgRepo.createOrganization({ name: 'Org1', slug: unique('org1') });
      orgRepo.createOrganization({ name: 'Org2', slug: unique('org2') });
      const list = orgRepo.listOrganizations();
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it('deletes an organization', () => {
      const org = orgRepo.createOrganization({ name: 'ToDelete', slug: unique('to-delete') });
      orgRepo.deleteOrganization(org.id);
      expect(orgRepo.getOrganizationById(org.id)).toBeNull();
    });
  });

  describe('Teams', () => {
    let orgId: string;

    beforeEach(() => {
      const org = orgRepo.createOrganization({ name: 'Team Org', slug: unique('team-org') });
      orgId = org.id;
    });

    it('creates a team', () => {
      const team = teamRepo.createTeam({ organizationId: orgId, name: 'Engineering', slug: unique('eng') });
      expect(team.name).toBe('Engineering');
      expect(team.organizationId).toBe(orgId);
    });

    it('lists teams by organization', () => {
      teamRepo.createTeam({ organizationId: orgId, name: 'Team A', slug: unique('team-a') });
      teamRepo.createTeam({ organizationId: orgId, name: 'Team B', slug: unique('team-b') });
      const teams = teamRepo.listTeamsByOrganization(orgId);
      expect(teams.length).toBeGreaterThanOrEqual(2);
    });

    it('deletes a team', () => {
      const team = teamRepo.createTeam({ organizationId: orgId, name: 'ToRemove', slug: unique('remove') });
      teamRepo.deleteTeam(team.id);
      expect(teamRepo.getTeamById(team.id)).toBeNull();
    });
  });

  describe('Team Members', () => {
    let teamId: string;

    beforeEach(() => {
      const org = orgRepo.createOrganization({ name: 'Member Org', slug: unique('member-org') });
      const team = teamRepo.createTeam({ organizationId: org.id, name: 'Member Team', slug: unique('member-team') });
      teamId = team.id;
    });

    it('adds a member', () => {
      const uid = unique('user');
      ensureUser(uid);
      const member = memberRepo.addMember({ teamId, userId: uid, role: 'member' });
      expect(member.userId).toContain('user');
      expect(member.role).toBe('member');
    });

    it('adds a member with owner role', () => {
      const uid = unique('user');
      ensureUser(uid);
      const member = memberRepo.addMember({ teamId, userId: uid, role: 'owner' });
      expect(member.role).toBe('owner');
    });

    it('lists members', () => {
      const uid1 = unique('user');
      const uid2 = unique('user');
      ensureUser(uid1);
      ensureUser(uid2);
      memberRepo.addMember({ teamId, userId: uid1, role: 'admin' });
      memberRepo.addMember({ teamId, userId: uid2, role: 'member' });
      const members = memberRepo.listMembers(teamId);
      expect(members.length).toBe(2);
    });

    it('updates member role', () => {
      const uid = unique('user');
      ensureUser(uid);
      memberRepo.addMember({ teamId, userId: uid, role: 'member' });
      const updated = memberRepo.updateMemberRole(teamId, uid, 'admin');
      expect(updated).not.toBeNull();
      expect(updated!.role).toBe('admin');
    });

    it('removes a member', () => {
      const uid = unique('user');
      ensureUser(uid);
      memberRepo.addMember({ teamId, userId: uid, role: 'member' });
      memberRepo.removeMember(teamId, uid);
      const member = memberRepo.getMember(teamId, uid);
      expect(member).toBeNull();
    });

    it('checks membership', () => {
      const uid = unique('user');
      ensureUser(uid);
      memberRepo.addMember({ teamId, userId: uid, role: 'member' });
      expect(memberRepo.isTeamMember(teamId, uid)).toBe(true);
      expect(memberRepo.isTeamMember(teamId, 'nonexistent')).toBe(false);
    });
  });

  describe('Board-Team Association', () => {
    it('creates a board with teamId', () => {
      const org = orgRepo.createOrganization({ name: 'Board Org', slug: unique('board-org') });
      const team = teamRepo.createTeam({ organizationId: org.id, name: 'Board Team', slug: unique('board-team') });

      const board = boardRepo.createBoard({ name: 'Team Board', teamId: team.id });
      expect(board.teamId).toBe(team.id);

      const found = boardRepo.getBoardById(board.id);
      expect(found!.teamId).toBe(team.id);
    });

    it('creates a board without teamId', () => {
      const board = boardRepo.createBoard({ name: 'Public Board' });
      expect(board.teamId).toBeNull();
    });

    it('lists boards filtered by team ids', () => {
      const org = orgRepo.createOrganization({ name: 'Filter Org', slug: unique('filter-org') });
      const team1 = teamRepo.createTeam({ organizationId: org.id, name: 'Filter Team 1', slug: unique('filter-t1') });
      const team2 = teamRepo.createTeam({ organizationId: org.id, name: 'Filter Team 2', slug: unique('filter-t2') });

      boardRepo.createBoard({ name: 'Team 1 Board', teamId: team1.id });
      boardRepo.createBoard({ name: 'Team 2 Board', teamId: team2.id });
      boardRepo.createBoard({ name: 'No Team Board' });

      const onlyTeam1 = boardRepo.listBoards(undefined, [team1.id]);
      expect(onlyTeam1.some(b => b.teamId === team1.id)).toBe(true);
      expect(onlyTeam1.some(b => b.teamId === team2.id)).toBe(false);
      expect(onlyTeam1.some(b => b.teamId === null)).toBe(true);
    });

    it('checks membership by board id', () => {
      const org = orgRepo.createOrganization({ name: 'Access Org', slug: unique('access-org') });
      const team = teamRepo.createTeam({ organizationId: org.id, name: 'Access Team', slug: unique('access-team') });

      const board = boardRepo.createBoard({ name: 'Access Board', teamId: team.id });

      const uid = unique('auth-user');
      ensureUser(uid);
      memberRepo.addMember({ teamId: team.id, userId: uid, role: 'member' });

      expect(memberRepo.isTeamMemberByBoardId(board.id, uid)).toBe(true);
      expect(memberRepo.isTeamMemberByBoardId(board.id, 'other-user')).toBe(false);
    });

    it('lists teams by user id', () => {
      const org = orgRepo.createOrganization({ name: 'User Teams Org', slug: unique('user-org') });
      const teamA = teamRepo.createTeam({ organizationId: org.id, name: 'User Team A', slug: unique('user-ta') });
      const teamB = teamRepo.createTeam({ organizationId: org.id, name: 'User Team B', slug: unique('user-tb') });

      const uid = unique('user-x');
      ensureUser(uid);
      memberRepo.addMember({ teamId: teamA.id, userId: uid, role: 'member' });
      memberRepo.addMember({ teamId: teamB.id, userId: uid, role: 'admin' });

      const userTeams = teamRepo.listTeamsByUserId(uid);
      expect(userTeams.length).toBe(2);
      expect(userTeams.some(t => t.id === teamA.id)).toBe(true);
      expect(userTeams.some(t => t.id === teamB.id)).toBe(true);
    });
  });
});
