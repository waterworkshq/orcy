import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/feature.js';
import * as reviewRuleRepo from '../repositories/reviewRule.js';
import * as taskReviewerRepo from '../repositories/taskReviewer.js';
import { tasks, columns as columnsTable, habitats, users, teamMembers, teams, organizations } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import {
  matchRules,
  assignReviewers,
  hasAssignedReviewers,
  isAssignedReviewer,
  recordApproval,
  hasAllRequiredApprovals,
  resetRoundRobinCounter,
} from '../services/reviewAssignmentService.js';

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  resetRoundRobinCounter();

  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  habitatId = habitat.id;

  const columns = columnRepo.createColumn({ habitatId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = columns.id;

  const mission = missionRepo.createMission({ habitatId, columnId, title: 'Test Mission', createdBy: 'test' });
  missionId = mission.id;
});

afterEach(() => {
  closeDb();
});

function createTestTask(options?: { requiredDomain?: string | null; priority?: string; labels?: string[] }) {
  return taskRepo.createTask({
    missionId,
    title: `Task-${Date.now()}`,
    createdBy: 'test',
    requiredDomain: options?.requiredDomain,
    priority: options?.priority as any,
    labels: options?.labels,
  });
}

function setupTeamWithUsers(teamHabitatId: string, userNames: string[]) {
  const db = getDb();
  const ts = Date.now();
  const orgId = `org-${ts}`;
  db.insert(organizations).values({ id: orgId, name: `Org-${ts}`, slug: `org-${ts}` }).run();

  const teamId = `team-${ts}`;
  db.insert(teams).values({ id: teamId, organizationId: orgId, name: `Team-${ts}`, slug: `team-${ts}` }).run();
  db.update(habitats).set({ teamId }).where(eq(habitats.id, teamHabitatId)).run();

  const userIds: string[] = [];
  for (const name of userNames) {
    const uid = `user-${name}-${ts}-${userIds.length}`;
    db.insert(users).values({ id: uid, username: `${name}-${ts}-${userIds.length}`, passwordHash: 'hash', displayName: name }).run();
    db.insert(teamMembers).values({ id: `tm-${uid}`, teamId, userId: uid }).run();
    userIds.push(uid);
  }

  return { teamId, userIds };
}

describe('matchRules', () => {
  it('returns empty array when no rules exist', () => {
    const task = createTestTask();
    const rules = matchRules(task.id, habitatId);
    expect(rules).toHaveLength(0);
  });

  it('matches a rule with no filters', () => {
    const task = createTestTask();
    reviewRuleRepo.create(habitatId, { name: 'Catch-all', priority: 0 });

    const rules = matchRules(task.id, habitatId);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('Catch-all');
  });

  it('matches rule by domain', () => {
    const task = createTestTask({ requiredDomain: 'backend' });
    reviewRuleRepo.create(habitatId, { name: 'Backend rule', matchDomain: 'backend' });
    reviewRuleRepo.create(habitatId, { name: 'Frontend rule', matchDomain: 'frontend' });

    const rules = matchRules(task.id, habitatId);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('Backend rule');
  });

  it('matches rule by priority', () => {
    const task = createTestTask({ priority: 'critical' });
    reviewRuleRepo.create(habitatId, { name: 'Critical rule', matchPriority: 'critical' });
    reviewRuleRepo.create(habitatId, { name: 'Low rule', matchPriority: 'low' });

    const rules = matchRules(task.id, habitatId);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('Critical rule');
  });

  it('matches rule by label overlap', () => {
    const task = createTestTask({ labels: ['bug', 'urgent'] });
    reviewRuleRepo.create(habitatId, { name: 'Bug rule', matchLabels: ['bug'] });
    reviewRuleRepo.create(habitatId, { name: 'Feature rule', matchLabels: ['feature'] });

    const rules = matchRules(task.id, habitatId);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('Bug rule');
  });

  it('skips disabled rules', () => {
    const task = createTestTask();
    reviewRuleRepo.create(habitatId, { name: 'Disabled rule', enabled: 0 });

    const rules = matchRules(task.id, habitatId);
    expect(rules).toHaveLength(0);
  });

  it('combines multiple filters (domain AND priority)', () => {
    const task = createTestTask({ requiredDomain: 'backend', priority: 'high' });
    reviewRuleRepo.create(habitatId, { name: 'Backend+High', matchDomain: 'backend', matchPriority: 'high' });
    reviewRuleRepo.create(habitatId, { name: 'Backend only', matchDomain: 'backend' });

    const rules = matchRules(task.id, habitatId);
    expect(rules).toHaveLength(2);
  });
});

describe('assignReviewers', () => {
  it('skips when no matching rules', () => {
    const task = createTestTask();
    const result = assignReviewers(task.id, habitatId);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_matching_rules');
  });

  it('skips when no eligible reviewers (no team)', () => {
    const task = createTestTask();
    reviewRuleRepo.create(habitatId, { name: 'Rule', requiredReviews: 1 });

    const result = assignReviewers(task.id, habitatId);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_eligible_reviewers');
  });

  it('assigns a reviewer from the team', () => {
    const task = createTestTask();
    const { userIds } = setupTeamWithUsers(habitatId, ['alice']);
    reviewRuleRepo.create(habitatId, { name: 'Rule', requiredReviews: 1 });

    const result = assignReviewers(task.id, habitatId);
    expect(result.skipped).toBe(false);
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0].reviewerId).toBe(userIds[0]);

    const reviewers = taskReviewerRepo.getByTaskId(task.id);
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0].reviewerId).toBe(userIds[0]);
    expect(reviewers[0].status).toBe('pending');
  });

  it('assigns multiple reviewers when requiredReviews > 1', () => {
    const task = createTestTask();
    setupTeamWithUsers(habitatId, ['alice', 'bob', 'charlie']);
    reviewRuleRepo.create(habitatId, { name: 'Rule', requiredReviews: 2 });

    const result = assignReviewers(task.id, habitatId);
    expect(result.assigned).toHaveLength(2);

    const reviewers = taskReviewerRepo.getByTaskId(task.id);
    expect(reviewers).toHaveLength(2);
  });

  it('excludes specified reviewer', () => {
    const task = createTestTask();
    const { userIds } = setupTeamWithUsers(habitatId, ['alice', 'bob']);
    reviewRuleRepo.create(habitatId, { name: 'Rule', requiredReviews: 1 });

    const result = assignReviewers(task.id, habitatId, userIds[0]);
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0].reviewerId).not.toBe(userIds[0]);
  });
});

describe('approval tracking', () => {
  it('tracks assigned reviewers', () => {
    const task = createTestTask();
    expect(hasAssignedReviewers(task.id)).toBe(false);

    setupTeamWithUsers(habitatId, ['alice']);
    reviewRuleRepo.create(habitatId, { name: 'Rule', requiredReviews: 1 });
    assignReviewers(task.id, habitatId);

    expect(hasAssignedReviewers(task.id)).toBe(true);
  });

  it('checks if user is assigned reviewer', () => {
    const task = createTestTask();
    const { userIds } = setupTeamWithUsers(habitatId, ['alice']);
    reviewRuleRepo.create(habitatId, { name: 'Rule', requiredReviews: 1 });
    assignReviewers(task.id, habitatId);

    expect(isAssignedReviewer(task.id, userIds[0])).toBe(true);
    expect(isAssignedReviewer(task.id, 'random-user')).toBe(false);
  });

  it('records approval and tracks completion', () => {
    const task = createTestTask();
    const { userIds } = setupTeamWithUsers(habitatId, ['alice']);
    reviewRuleRepo.create(habitatId, { name: 'Rule', requiredReviews: 1 });
    assignReviewers(task.id, habitatId);

    expect(hasAllRequiredApprovals(task.id)).toBe(false);

    recordApproval(task.id, userIds[0]);
    expect(hasAllRequiredApprovals(task.id)).toBe(true);
  });

  it('requires all reviewers to approve', () => {
    const task = createTestTask();
    const { userIds } = setupTeamWithUsers(habitatId, ['alice', 'bob']);
    reviewRuleRepo.create(habitatId, { name: 'Rule', requiredReviews: 2 });
    assignReviewers(task.id, habitatId);

    recordApproval(task.id, userIds[0]);
    expect(hasAllRequiredApprovals(task.id)).toBe(false);

    recordApproval(task.id, userIds[1]);
    expect(hasAllRequiredApprovals(task.id)).toBe(true);
  });
});
