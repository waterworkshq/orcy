import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as columnRepo from '../repositories/column.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/feature.js';
import * as agentRepo from '../repositories/agent.js';
import * as reviewRuleRepo from '../repositories/reviewRule.js';
import * as taskReviewerRepo from '../repositories/taskReviewer.js';
import { tasks, columns as columnsTable, habitats, users, teamMembers, teams, organizations } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { claimTask, startTask, submitTask, approveTask, completeTask } from '../services/tasks/task-lifecycle.js';
import { resetRoundRobinCounter } from '../services/reviewAssignmentService.js';

let habitatId: string;
let columnId: string;
let agentId: string;

function setupTeamWithUsers(habId: string, userNames: string[]) {
  const db = getDb();
  const ts = Date.now();
  const orgId = `org-${ts}`;
  db.insert(organizations).values({ id: orgId, name: `Org-${ts}`, slug: `org-${ts}` }).run();

  const teamId = `team-${ts}`;
  db.insert(teams).values({ id: teamId, organizationId: orgId, name: `Team-${ts}`, slug: `team-${ts}` }).run();
  db.update(habitats).set({ teamId }).where(eq(habitats.id, habId)).run();

  const userIds: string[] = [];
  for (const name of userNames) {
    const uid = `user-${name}-${ts}-${userIds.length}`;
    db.insert(users).values({ id: uid, username: `${name}-${ts}-${userIds.length}`, passwordHash: 'hash', displayName: name }).run();
    db.insert(teamMembers).values({ id: `tm-${uid}`, teamId, userId: uid }).run();
    userIds.push(uid);
  }

  return { teamId, userIds };
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  resetRoundRobinCounter();

  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  habitatId = habitat.id;

  const col = columnRepo.createColumn({ habitatId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = col.id;

  const agent = agentRepo.createAgent({ name: 'test-agent', type: 'claude-code', domain: 'fullstack' });
  agentId = agent.agent.id;
});

afterEach(() => {
  closeDb();
});

function createTaskWithMission() {
  const mission = missionRepo.createMission({ habitatId, columnId, title: 'Test Mission', createdBy: 'test' });
  return taskRepo.createTask({ missionId: mission.id, title: 'Test Task', createdBy: 'test' });
}

function fullClaimStartSubmit(taskId: string) {
  claimTask(taskId, agentId);
  startTask(taskId, agentId);
  return submitTask(taskId, agentId, 'Done', []);
}

describe('Review Rules: submitTask integration', () => {
  it('assigns reviewers on submit when rules exist', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice', 'Bob']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 2 });

    const task = createTaskWithMission();
    const result = fullClaimStartSubmit(task.id);

    expect(result.task).not.toBeNull();
    const reviewers = taskReviewerRepo.getByTaskId(task.id);
    expect(reviewers).toHaveLength(2);
  });

  it('does not assign reviewers when no rules configured', () => {
    const task = createTaskWithMission();
    const result = fullClaimStartSubmit(task.id);

    expect(result.task).not.toBeNull();
    const reviewers = taskReviewerRepo.getByTaskId(task.id);
    expect(reviewers).toHaveLength(0);
  });

  it('submits successfully even if reviewer assignment fails', () => {
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 1 });

    const task = createTaskWithMission();
    const result = fullClaimStartSubmit(task.id);

    expect(result.task).not.toBeNull();
    expect(result.task!.status).toBe('submitted');
  });
});

describe('Review Rules: approveTask integration', () => {
  it('records partial approval and keeps task submitted when more reviews needed', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice', 'Bob']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 2 });

    const task = createTaskWithMission();
    fullClaimStartSubmit(task.id);

    const afterFirstApproval = approveTask(task.id, userIds[0]);

    expect(afterFirstApproval).not.toBeNull();
    expect(afterFirstApproval!.status).toBe('submitted');

    const reviewers = taskReviewerRepo.getByTaskId(task.id);
    const approvedCount = reviewers.filter(r => r.status === 'approved').length;
    expect(approvedCount).toBe(1);
  });

  it('transitions task to approved on final approval', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice', 'Bob']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 2 });

    const task = createTaskWithMission();
    fullClaimStartSubmit(task.id);

    approveTask(task.id, userIds[0]);
    const afterSecondApproval = approveTask(task.id, userIds[1]);

    expect(afterSecondApproval).not.toBeNull();
    expect(afterSecondApproval!.status).toBe('approved');
  });

  it('rejects approval from non-assigned reviewer', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice', 'Bob', 'Charlie']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 1 });

    const task = createTaskWithMission();
    fullClaimStartSubmit(task.id);

    const result = approveTask(task.id, userIds[2]);

    expect(result).toBeNull();
  });

  it('works without review rules (legacy behavior)', () => {
    const task = createTaskWithMission();
    fullClaimStartSubmit(task.id);

    const result = approveTask(task.id, 'any-reviewer');

    expect(result).not.toBeNull();
    expect(result!.status).toBe('approved');
  });

  it('single required review transitions immediately', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 1 });

    const task = createTaskWithMission();
    fullClaimStartSubmit(task.id);

    const result = approveTask(task.id, userIds[0]);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('approved');
  });
});

describe('Review Rules: completeTask integration', () => {
  it('blocks completion when task is submitted and has pending reviews', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice', 'Bob']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 2 });

    const task = createTaskWithMission();
    fullClaimStartSubmit(task.id);

    approveTask(task.id, userIds[0]);

    const result = completeTask(task.id, agentId, 'Self-complete');

    expect(result.task).toBeNull();
    expect(result.error).toBe('REVIEW_REQUIRED');
  });

  it('allows completion after all reviews are approved', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 1 });

    const task = createTaskWithMission();
    fullClaimStartSubmit(task.id);

    approveTask(task.id, userIds[0]);

    const result = completeTask(task.id, agentId, 'All reviews done');

    expect(result.task).not.toBeNull();
    expect(result.task!.status).toBe('done');
  });

  it('allows self-completion when no review rules configured (legacy)', () => {
    const task = createTaskWithMission();
    fullClaimStartSubmit(task.id);

    const result = completeTask(task.id, agentId, 'Self-complete');

    expect(result.task).not.toBeNull();
    expect(result.task!.status).toBe('done');
  });

  it('allows completion from approved status even with review rules', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 1 });

    const task = createTaskWithMission();
    fullClaimStartSubmit(task.id);

    approveTask(task.id, userIds[0]);

    const result = completeTask(task.id, agentId, 'Done');

    expect(result.task).not.toBeNull();
    expect(result.task!.status).toBe('done');
  });
});
