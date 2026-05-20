import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/feature.js';
import * as agentRepo from '../repositories/agent.js';
import * as reviewRuleRepo from '../repositories/reviewRule.js';
import * as taskReviewerRepo from '../repositories/taskReviewer.js';
import * as sprintRepo from '../repositories/sprint.js';
import { tasks, columns as columnsTable, habitats, missions, users, teamMembers, teams, organizations } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { claimTask, startTask, submitTask, approveTask, completeTask } from '../services/tasks/task-lifecycle.js';
import {
  createSprint,
  startSprint,
  completeSprint,
  addMissionToSprint,
  getSprintsForHabitat,
} from '../services/sprintService.js';
import { resetRoundRobinCounter } from '../services/reviewAssignmentService.js';

let habitatId: string;
let columnId: string;
let agentId: string;

function setupTeamWithUsers(habId: string, userNames: string[]) {
  const db = getDb();
  const ts = Date.now();
  const orgId = `org-cross-${ts}`;
  db.insert(organizations).values({ id: orgId, name: `Org-${ts}`, slug: `org-${ts}` }).run();

  const teamId = `team-cross-${ts}`;
  db.insert(teams).values({ id: teamId, organizationId: orgId, name: `Team-${ts}`, slug: `team-${ts}` }).run();
  db.update(habitats).set({ teamId }).where(eq(habitats.id, habId)).run();

  const userIds: string[] = [];
  for (const name of userNames) {
    const uid = `user-cross-${name}-${ts}-${userIds.length}`;
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
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  resetRoundRobinCounter();

  const habitat = habitatRepo.createHabitat({ name: 'Cross-Feature Habitat' });
  habitatId = habitat.id;

  const col = columnRepo.createColumn({ habitatId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = col.id;

  const agent = agentRepo.createAgent({ name: 'cross-agent', type: 'claude-code', domain: 'fullstack' });
  agentId = agent.agent.id;
});

afterEach(() => {
  closeDb();
});

function createTaskWithMission(title = 'Test Task') {
  const mission = missionRepo.createMission({ habitatId, columnId, title: `Mission for ${title}`, createdBy: 'test' });
  return { mission, task: taskRepo.createTask({ missionId: mission.id, title, createdBy: 'test' }) };
}

function claimStartSubmit(taskId: string) {
  claimTask(taskId, agentId);
  startTask(taskId, agentId);
  return submitTask(taskId, agentId, 'Done', []);
}

describe('Cross-feature: Sprint tasks with review gates', () => {
  it('sprint mission tasks go through full review lifecycle', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Reviewer']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 1 });

    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const { mission, task } = createTaskWithMission('Sprint Task');
    addMissionToSprint(sprint.id, mission.id);
    startSprint(sprint.id);

    expect(missionRepo.getMissionById(mission.id)?.sprintId).toBe(sprint.id);

    claimStartSubmit(task.id);

    const reviewers = taskReviewerRepo.getByTaskId(task.id);
    expect(reviewers.length).toBeGreaterThanOrEqual(1);

    approveTask(task.id, userIds[0]);
    completeTask(task.id, agentId, 'Done');

    const updatedTask = taskRepo.getTaskById(task.id);
    expect(updatedTask?.status).toBe('done');
  });

  it('review-gated task in sprint blocks completion until approved', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice', 'Bob']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 2 });

    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const { mission, task } = createTaskWithMission('Blocked Task');
    addMissionToSprint(sprint.id, mission.id);
    startSprint(sprint.id);

    claimStartSubmit(task.id);
    approveTask(task.id, userIds[0]);

    const blocked = completeTask(task.id, agentId, 'Try complete');
    expect(blocked.error).toBe('REVIEW_REQUIRED');
    expect(blocked.task).toBeNull();

    approveTask(task.id, userIds[1]);
    const success = completeTask(task.id, agentId, 'Now complete');
    expect(success.task?.status).toBe('done');
  });
});

describe('Cross-feature: Sprint carry-over with review rules active', () => {
  it('carries over incomplete missions to backlog when sprint completes', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Reviewer']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 1 });

    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const { mission: m1, task: t1 } = createTaskWithMission('Done Task');
    const { mission: m2, task: t2 } = createTaskWithMission('Open Task');
    addMissionToSprint(sprint.id, m1.id);
    addMissionToSprint(sprint.id, m2.id);
    startSprint(sprint.id);

    claimStartSubmit(t1.id);
    approveTask(t1.id, userIds[0]);
    completeTask(t1.id, agentId, 'Done');
    missionRepo.updateMission(m1.id, { status: 'done' });

    const result = completeSprint(sprint.id);

    expect(result.status).toBe('completed');
    expect(missionRepo.getMissionById(m1.id)?.sprintId).toBe(sprint.id);
    expect(missionRepo.getMissionById(m2.id)?.sprintId).toBeNull();
  });

  it('review rules do not interfere with sprint state transitions', () => {
    setupTeamWithUsers(habitatId, ['Reviewer']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 1 });

    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const { mission } = createTaskWithMission('Sprint Mission');
    addMissionToSprint(sprint.id, mission.id);

    startSprint(sprint.id);
    expect(sprintRepo.getById(sprint.id)?.status).toBe('active');

    completeSprint(sprint.id);
    expect(sprintRepo.getById(sprint.id)?.status).toBe('completed');
  });
});

describe('Cross-feature: Multiple sprints with review rules', () => {
  it('completes sprint 1, creates sprint 2, and assigns reviewers in sprint 2', () => {
    const { userIds } = setupTeamWithUsers(habitatId, ['Alice']);
    reviewRuleRepo.create(habitatId, { name: 'All tasks', requiredReviews: 1 });

    const sprint1 = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const { mission: m1, task: t1 } = createTaskWithMission('Sprint 1 Task');
    addMissionToSprint(sprint1.id, m1.id);
    startSprint(sprint1.id);

    claimStartSubmit(t1.id);
    approveTask(t1.id, userIds[0]);
    completeTask(t1.id, agentId, 'Done');
    missionRepo.updateMission(m1.id, { status: 'done' });

    completeSprint(sprint1.id);

    const sprint2 = createSprint(habitatId, { name: 'Sprint 2', startDate: '2026-06-15', endDate: '2026-06-28' }, 'user-1');
    const { mission: m2, task: t2 } = createTaskWithMission('Sprint 2 Task');
    addMissionToSprint(sprint2.id, m2.id);
    startSprint(sprint2.id);

    resetRoundRobinCounter();
    claimStartSubmit(t2.id);

    const reviewers = taskReviewerRepo.getByTaskId(t2.id);
    expect(reviewers.length).toBeGreaterThanOrEqual(1);

    approveTask(t2.id, userIds[0]);
    completeTask(t2.id, agentId, 'Done');

    expect(taskRepo.getTaskById(t2.id)?.status).toBe('done');
  });
});
