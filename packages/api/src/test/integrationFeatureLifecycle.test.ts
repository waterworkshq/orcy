import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDb, initTestDb, getDb } from '../db/index.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as columnRepo from '../repositories/column.js';
import * as missionRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as agentRepo from '../repositories/agent.js';
import * as missionService from '../services/featureService.js';
import * as habitatService from '../services/boardService.js';
import { getTaskDetails } from '../services/tasks/task-details.js';
import { claimTask, startTask, submitTask, approveTask } from '../services/tasks/task-lifecycle.js';
import { missionDependencies, taskDependencies } from '../db/schema/index.js';
import { eq, sql, notInArray } from 'drizzle-orm';

async function setupHabitat() {
  const { habitat, columns } = habitatService.createHabitat({ name: 'Test', defaultColumns: true });
  const agent = agentRepo.createAgent({ name: 'test-agent', type: 'claude-code', domain: 'fullstack' });
  return { habitat, columns, agent };
}

describe('Integration: Mission Lifecycle', () => {
  beforeEach(async () => { await initTestDb(); });
  afterEach(() => { closeDb(); });

  it('task claim → mission status changes to in_progress → mission auto-advances to In Progress column', async () => {
    const { habitat, columns, agent } = await setupHabitat();
    const todoCol = columns[0];
    const inProgressCol = columns[1];

    const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: todoCol.id, title: 'Auth Mission', createdBy: 'test' });
    expect(mission.status).toBe('not_started');
    expect(mission.columnId).toBe(todoCol.id);

    const task = taskRepo.createTask({ missionId: mission.id, title: 'Implement login', createdBy: 'test' });
    expect(task.status).toBe('pending');

    const result = claimTask(task.id, agent.agent.id);
    expect(result.success).toBe(true);

    const updatedMission = missionRepo.getMissionById(mission.id)!;
    expect(updatedMission.status).toBe('in_progress');
    expect(updatedMission.columnId).toBe(inProgressCol.id);
  });

  it('all tasks submitted → mission status changes to review → mission auto-advances to Review column', async () => {
    const { habitat, columns, agent } = await setupHabitat();
    const todoCol = columns[0];
    const reviewCol = columns[2];

    const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: todoCol.id, title: 'Review Mission', createdBy: 'test' });
    const task1 = taskRepo.createTask({ missionId: mission.id, title: 'Task 1', createdBy: 'test' });
    const task2 = taskRepo.createTask({ missionId: mission.id, title: 'Task 2', createdBy: 'test' });

    claimTask(task1.id, agent.agent.id);
    startTask(task1.id, agent.agent.id);
    claimTask(task2.id, agent.agent.id);
    startTask(task2.id, agent.agent.id);

    submitTask(task1.id, agent.agent.id, 'Done task 1', []);
    const fAfterFirst = missionRepo.getMissionById(mission.id)!;
    expect(fAfterFirst.status).toBe('in_progress');

    submitTask(task2.id, agent.agent.id, 'Done task 2', []);

    const updatedMission = missionRepo.getMissionById(mission.id)!;
    expect(updatedMission.status).toBe('review');
    expect(updatedMission.columnId).toBe(reviewCol.id);
  });

  it('all tasks done → mission status changes to done → mission auto-advances to Done column', async () => {
    const { habitat, columns, agent } = await setupHabitat();
    const todoCol = columns[0];
    const doneCol = columns[3];

    const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: todoCol.id, title: 'Done Mission', createdBy: 'test' });
    const task1 = taskRepo.createTask({ missionId: mission.id, title: 'Task 1', createdBy: 'test' });
    const task2 = taskRepo.createTask({ missionId: mission.id, title: 'Task 2', createdBy: 'test' });

    claimTask(task1.id, agent.agent.id);
    startTask(task1.id, agent.agent.id);
    submitTask(task1.id, agent.agent.id, 'Done 1', []);

    claimTask(task2.id, agent.agent.id);
    startTask(task2.id, agent.agent.id);
    submitTask(task2.id, agent.agent.id, 'Done 2', []);

    approveTask(task1.id, 'reviewer');
    approveTask(task2.id, 'reviewer');

    taskRepo.updateTask(task1.id, { status: 'done' });
    missionService.recalculateMissionStatus(mission.id);

    const updatedMission = missionRepo.getMissionById(mission.id)!;
    expect(updatedMission.status).toBe('done');
    expect(updatedMission.columnId).toBe(doneCol.id);
  });

  it('habitat summary returns missions with task progress counts', async () => {
    const { habitat, columns } = await setupHabitat();

    const mission1 = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Mission A', createdBy: 'test' });
    const mission2 = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Mission B', createdBy: 'test' });

    taskRepo.createTask({ missionId: mission1.id, title: 'T1', createdBy: 'test' });
    taskRepo.createTask({ missionId: mission1.id, title: 'T2', createdBy: 'test' });
    taskRepo.createTask({ missionId: mission2.id, title: 'T3', createdBy: 'test' });

    const { missions: missionList } = missionService.listMissions(habitat.id);
    expect(missionList).toHaveLength(2);

    const f1 = missionList.find(f => f.id === mission1.id)!;
    expect(f1.progress.total).toBe(2);
    expect(f1.progress.pending).toBe(2);
    expect(f1.progress.inProgress).toBe(0);

    const f2 = missionList.find(f => f.id === mission2.id)!;
    expect(f2.progress.total).toBe(1);
    expect(f2.progress.pending).toBe(1);
  });

  it('task context includes parent mission description and sibling results', async () => {
    const { habitat, columns, agent } = await setupHabitat();

    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0].id,
      title: 'Mission X',
      description: 'Build the auth module',
      acceptanceCriteria: 'All tests pass',
      createdBy: 'test',
    });

    const task1 = taskRepo.createTask({ missionId: mission.id, title: 'Sibling task', createdBy: 'test' });
    const task2 = taskRepo.createTask({ missionId: mission.id, title: 'Main task', createdBy: 'test' });

    claimTask(task1.id, agent.agent.id);
    startTask(task1.id, agent.agent.id);
    submitTask(task1.id, agent.agent.id, 'Sibling result here', []);

    const details = await getTaskDetails(task2.id);
    expect(details).not.toBeNull();
    expect(details!.mission).not.toBeNull();
    expect(details!.mission!.title).toBe('Mission X');
    expect(details!.mission!.description).toBe('Build the auth module');
    expect(details!.mission!.acceptanceCriteria).toBe('All tests pass');

    expect(details!.siblingTasks).toHaveLength(1);
    expect(details!.siblingTasks[0].id).toBe(task1.id);
    expect(details!.siblingTasks[0].status).toBe('submitted');
    expect(details!.siblingTasks[0].result).toBe('Sibling result here');
  });

  it('available tasks filter respects mission dependencies', async () => {
    const { habitat, columns } = await setupHabitat();

    const missionA = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Mission A', createdBy: 'test' });
    const missionB = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0].id,
      title: 'Mission B',
      createdBy: 'test',
      dependsOn: [missionA.id],
    });

    const taskA = taskRepo.createTask({ missionId: missionA.id, title: 'Task A', createdBy: 'test' });
    const taskB = taskRepo.createTask({ missionId: missionB.id, title: 'Task B', createdBy: 'test' });

    const availableBefore = taskRepo.getAvailableTasksForAgent(habitat.id, 'fullstack');
    const availableIds = availableBefore.map(t => t.id);

    expect(availableIds).toContain(taskA.id);
    expect(availableIds).not.toContain(taskB.id);

    missionRepo.updateMission(missionA.id, { status: 'done' });
    const availableAfter = taskRepo.getAvailableTasksForAgent(habitat.id, 'fullstack');
    const afterIds = availableAfter.map(t => t.id);
    expect(afterIds).toContain(taskB.id);
  });

  it('available tasks filter respects task-level dependencies (correlated subquery)', async () => {
    const { habitat, columns, agent } = await setupHabitat();
    const db = getDb();

    const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Mission', createdBy: 'test' });

    const depTarget = taskRepo.createTask({ missionId: mission.id, title: 'Dependency target', createdBy: 'test' });
    const dependent = taskRepo.createTask({ missionId: mission.id, title: 'Has met deps', createdBy: 'test' });
    const blocked = taskRepo.createTask({ missionId: mission.id, title: 'Has unmet deps', createdBy: 'test' });
    const blocker = taskRepo.createTask({ missionId: mission.id, title: 'Blocker not done', createdBy: 'test' });

    db.insert(taskDependencies).values({ taskId: dependent.id, dependsOnId: depTarget.id }).run();
    db.insert(taskDependencies).values({ taskId: blocked.id, dependsOnId: blocker.id }).run();

    claimTask(depTarget.id, agent.agent.id);
    startTask(depTarget.id, agent.agent.id);
    submitTask(depTarget.id, agent.agent.id, 'Done', []);
    approveTask(depTarget.id, agent.agent.id);

    const available = taskRepo.getAvailableTasksForAgent(habitat.id, 'fullstack');
    const availableIds = available.map(t => t.id);

    expect(availableIds).toContain(dependent.id);
    expect(availableIds).not.toContain(blocked.id);
  });

  it('createMission atomically creates mission and dependency rows', async () => {
    const { habitat, columns } = await setupHabitat();

    const missionA = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Mission A', createdBy: 'test' });
    const missionB = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0].id,
      title: 'Mission B',
      createdBy: 'test',
      dependsOn: [missionA.id],
    });

    expect(missionB.dependsOn).toEqual([missionA.id]);

    const db = getDb();
    const deps = db.select().from(missionDependencies).where(eq(missionDependencies.missionId, missionB.id)).all();
    expect(deps).toHaveLength(1);
    expect(deps[0].dependsOnId).toBe(missionA.id);
  });

  it('createMission rolls back mission row when dependency insert fails', async () => {
    const { habitat, columns } = await setupHabitat();

    const db = getDb();
    db.run(sql`PRAGMA foreign_keys = ON`);

    const fakeDepId = '00000000-0000-0000-0000-000000000000';
    expect(() => {
      missionRepo.createMission({
        habitatId: habitat.id,
        columnId: columns[0].id,
        title: 'Orphan Mission',
        createdBy: 'test',
        dependsOn: [fakeDepId],
      });
    }).toThrow();

    const allMissions = missionRepo.getMissionsByHabitatId(habitat.id);
    expect(allMissions.missions.find(f => f.title === 'Orphan Mission')).toBeUndefined();

    db.run(sql`PRAGMA foreign_keys = OFF`);
  });

  it('createMission with blocks creates reverse dependency rows in mission_dependencies', async () => {
    const { habitat, columns } = await setupHabitat();

    const missionB = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Blocked Mission', createdBy: 'test' });
    const missionA = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0].id,
      title: 'Blocker Mission',
      createdBy: 'test',
      blocks: [missionB.id],
    });

    expect(missionA.blocks).toEqual([missionB.id]);

    const db = getDb();
    const deps = db.select().from(missionDependencies).where(eq(missionDependencies.missionId, missionB.id)).all();
    expect(deps).toHaveLength(1);
    expect(deps[0].dependsOnId).toBe(missionA.id);
  });

  it('blocks dependency prevents tasks from appearing available via areAllMissionDependenciesMet', async () => {
    const { habitat, columns } = await setupHabitat();

    const missionB = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Blocked', createdBy: 'test' });
    const missionA = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0].id,
      title: 'Blocker',
      createdBy: 'test',
      blocks: [missionB.id],
    });

    expect(missionRepo.areAllMissionDependenciesMet(missionB.id)).toBe(false);

    missionRepo.updateMission(missionA.id, { status: 'done' });
    expect(missionRepo.areAllMissionDependenciesMet(missionB.id)).toBe(true);
  });

  it('updateMission syncs blocks changes to mission_dependencies', async () => {
    const { habitat, columns } = await setupHabitat();

    const missionB = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Blocked', createdBy: 'test' });
    const missionC = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Also Blocked', createdBy: 'test' });
    const missionA = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Blocker', createdBy: 'test' });

    missionRepo.updateMission(missionA.id, { blocks: [missionB.id, missionC.id] });

    const db = getDb();
    const depsB = db.select().from(missionDependencies).where(eq(missionDependencies.missionId, missionB.id)).all();
    expect(depsB).toHaveLength(1);
    expect(depsB[0].dependsOnId).toBe(missionA.id);

    const depsC = db.select().from(missionDependencies).where(eq(missionDependencies.missionId, missionC.id)).all();
    expect(depsC).toHaveLength(1);
    expect(depsC[0].dependsOnId).toBe(missionA.id);

    missionRepo.updateMission(missionA.id, { blocks: [missionC.id] });

    const depsBAfter = db.select().from(missionDependencies).where(eq(missionDependencies.missionId, missionB.id)).all();
    expect(depsBAfter).toHaveLength(0);

    const depsCAfter = db.select().from(missionDependencies).where(eq(missionDependencies.missionId, missionC.id)).all();
    expect(depsCAfter).toHaveLength(1);
    expect(depsCAfter[0].dependsOnId).toBe(missionA.id);
  });

  it('updateMission clearing blocks removes all reverse dependency rows', async () => {
    const { habitat, columns } = await setupHabitat();

    const missionB = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: 'Blocked', createdBy: 'test' });
    const missionA = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0].id,
      title: 'Blocker',
      createdBy: 'test',
      blocks: [missionB.id],
    });

    const db = getDb();
    const depsBefore = db.select().from(missionDependencies).where(eq(missionDependencies.missionId, missionB.id)).all();
    expect(depsBefore).toHaveLength(1);

    missionRepo.updateMission(missionA.id, { blocks: [] });

    const depsAfter = db.select().from(missionDependencies).where(eq(missionDependencies.missionId, missionB.id)).all();
    expect(depsAfter).toHaveLength(0);
  });

  it('reorderMission increments version for change detection', async () => {
    const { habitat, columns } = await setupHabitat();
    const colId = columns[0].id;

    const missionA = missionRepo.createMission({ habitatId: habitat.id, columnId: colId, title: 'A', createdBy: 'test' });
    const missionB = missionRepo.createMission({ habitatId: habitat.id, columnId: colId, title: 'B', createdBy: 'test' });
    const missionC = missionRepo.createMission({ habitatId: habitat.id, columnId: colId, title: 'C', createdBy: 'test' });

    expect(missionA.version).toBe(1);

    const reordered = missionRepo.reorderMission(missionA.id, missionC.id, null);
    expect(reordered).not.toBeNull();
    expect(reordered!.version).toBe(2);

    const reorderedAgain = missionRepo.reorderMission(missionA.id, null, missionB.id);
    expect(reorderedAgain!.version).toBe(3);
  });

  it('mission archive and unarchive lifecycle', async () => {
    const { habitat, columns } = await setupHabitat();
    const todoCol = columns[0];
    const doneCol = columns[3];

    const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: todoCol.id, title: 'Archival Test', createdBy: 'test' });
    const task = taskRepo.createTask({ missionId: mission.id, title: 'Task to be archived', createdBy: 'test' });

    // Archiving a not_done mission should fail
    const archiveFailResult = missionService.archiveMission(mission.id, 'user');
    expect(archiveFailResult.success).toBe(false);
    expect('reason' in archiveFailResult && archiveFailResult.reason).toBe('not_done');

    // Move to done
    missionRepo.updateMission(mission.id, { status: 'done', columnId: doneCol.id });

    // Archive it
    const archiveResult = missionService.archiveMission(mission.id, 'user');
    expect(archiveResult.success).toBe(true);

    const archivedMission = missionRepo.getMissionById(mission.id)!;
    expect(archivedMission.isArchived).toBe(true);

    // List active missions should not include it
    const activeMissions = missionService.listMissions(habitat.id, { isArchived: false });
    expect(activeMissions.missions.find(f => f.id === mission.id)).toBeUndefined();

    // List archived missions should include it
    const listArchived = missionService.listMissions(habitat.id, { isArchived: true });
    expect(listArchived.missions.find(f => f.id === mission.id)).toBeDefined();

    // Cannot modify archived mission
    const updateResult = missionService.updateMission(mission.id, { title: 'Changed' }, 'user');
    expect(updateResult.success).toBe(false);
    expect('archived' in updateResult && updateResult.archived).toBe(true);

    // Unarchive it
    const unarchiveResult = missionService.unarchiveMission(mission.id, 'user');
    expect(unarchiveResult.success).toBe(true);

    const unarchivedMission = missionRepo.getMissionById(mission.id)!;
    expect(unarchivedMission.isArchived).toBe(false);

    // Can modify again
    const updateAgain = missionService.updateMission(mission.id, { title: 'Changed' }, 'user');
    expect(updateAgain.success).toBe(true);
    expect('mission' in updateAgain && updateAgain.mission.title).toBe('Changed');
  });
});
