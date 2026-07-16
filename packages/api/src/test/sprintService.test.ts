import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as columnRepo from '../repositories/column.js';
import * as missionRepo from '../repositories/feature.js';
import * as sprintRepo from '../repositories/sprint.js';
import { tasks, columns as columnsTable, habitats, missions } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import {
  createSprint,
  getSprintsForHabitat,
  updateSprint,
  deleteSprint,
  startSprint,
  completeSprint,
  cancelSprint,
  addMissionToSprint,
  removeMissionFromSprint,
} from '../services/sprintService.js';

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  habitatId = habitat.id;

  const columns = columnRepo.createColumn({ habitatId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = columns.id;
});

afterEach(() => {
  closeDb();
});

function createTestMission(title: string, status: string = 'not_started') {
  const mission = missionRepo.createMission({ habitatId, columnId, title, createdBy: 'test' });
  if (status !== 'not_started') {
    missionRepo.updateMission(mission.id, { status: status as any });
  }
  return mission;
}

describe('createSprint', () => {
  it('creates a sprint in planning status', () => {
    const sprint = createSprint(habitatId, {
      name: 'Sprint 1',
      startDate: '2026-06-01',
      endDate: '2026-06-14',
    }, 'user-1');

    expect(sprint.name).toBe('Sprint 1');
    expect(sprint.status).toBe('planning');
    expect(sprint.habitatId).toBe(habitatId);
    expect(sprint.createdBy).toBe('user-1');
  });

  it('rejects creating a sprint when habitat already has active sprint', () => {
    createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    startSprint(getSprintsForHabitat(habitatId)[0].id);

    expect(() => createSprint(habitatId, { name: 'Sprint 2', startDate: '2026-06-15', endDate: '2026-06-28' }, 'user-1'))
      .toThrow('Habitat already has an active sprint');
  });
});

describe('startSprint', () => {
  it('transitions from planning to active', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const started = startSprint(sprint.id);

    expect(started.status).toBe('active');
  });

  it('rejects starting a non-planning sprint', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    startSprint(sprint.id);

    expect(() => startSprint(sprint.id)).toThrow('Sprint is not in planning status');
  });
});

describe('completeSprint', () => {
  it('transitions from active to completed', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    startSprint(sprint.id);
    const completed = completeSprint(sprint.id);

    expect(completed.status).toBe('completed');
  });

  it('carries over incomplete missions to backlog by default', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const m1 = createTestMission('Done mission', 'done');
    const m2 = createTestMission('Incomplete mission', 'in_progress');
    addMissionToSprint(sprint.id, m1.id);
    addMissionToSprint(sprint.id, m2.id);
    startSprint(sprint.id);

    const completed = completeSprint(sprint.id);
    expect(completed.status).toBe('completed');
    expect(completed.completedMissionIds).toContain(m1.id);

    const updatedM2 = missionRepo.getMissionById(m2.id);
    expect(updatedM2?.sprintId).toBeNull();
  });

  it('carries over to next planning sprint when policy is next_sprint', () => {
    const db = getDb();
    db.update(habitats).set({ carryOverPolicy: 'next_sprint' }).where(eq(habitats.id, habitatId)).run();

    const s1 = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const s2 = createSprint(habitatId, { name: 'Sprint 2', startDate: '2026-06-15', endDate: '2026-06-28' }, 'user-1');

    const m1 = createTestMission('Incomplete', 'in_progress');
    addMissionToSprint(s1.id, m1.id);
    startSprint(s1.id);

    completeSprint(s1.id);

    const updatedM1 = missionRepo.getMissionById(m1.id);
    expect(updatedM1?.sprintId).toBe(s2.id);
    const s2updated = sprintRepo.getById(s2.id);
    expect(s2updated?.committedMissionIds).toContain(m1.id);
  });

  it('leaves incomplete missions in completed sprint when policy is none', () => {
    const db = getDb();
    db.update(habitats).set({ carryOverPolicy: 'none' }).where(eq(habitats.id, habitatId)).run();

    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const m1 = createTestMission('Incomplete', 'in_progress');
    addMissionToSprint(sprint.id, m1.id);
    startSprint(sprint.id);

    completeSprint(sprint.id);

    const updatedM1 = missionRepo.getMissionById(m1.id);
    expect(updatedM1?.sprintId).toBe(sprint.id);
  });
});

describe('cancelSprint', () => {
  it('cancels a planning sprint and unlinks missions', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const m1 = createTestMission('Mission');
    addMissionToSprint(sprint.id, m1.id);

    cancelSprint(sprint.id);

    const updated = sprintRepo.getById(sprint.id);
    expect(updated?.status).toBe('cancelled');

    const mission = missionRepo.getMissionById(m1.id);
    expect(mission?.sprintId).toBeNull();
  });

  it('cancels an active sprint', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    startSprint(sprint.id);
    cancelSprint(sprint.id);

    expect(sprintRepo.getById(sprint.id)?.status).toBe('cancelled');
  });
});

describe('addMission / removeMission', () => {
  it('adds mission to planning sprint and sets sprintId on mission', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const m1 = createTestMission('Mission');

    const updated = addMissionToSprint(sprint.id, m1.id);

    expect(updated.committedMissionIds).toContain(m1.id);
    expect(missionRepo.getMissionById(m1.id)?.sprintId).toBe(sprint.id);
  });

  it('rejects adding to active sprint', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    startSprint(sprint.id);
    const m1 = createTestMission('Mission');

    expect(() => addMissionToSprint(sprint.id, m1.id)).toThrow('Can only add missions to a planning sprint');
  });

  it('removes mission from planning sprint and clears sprintId', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const m1 = createTestMission('Mission');
    addMissionToSprint(sprint.id, m1.id);

    removeMissionFromSprint(sprint.id, m1.id);

    expect(sprintRepo.getById(sprint.id)?.committedMissionIds).not.toContain(m1.id);
    expect(missionRepo.getMissionById(m1.id)?.sprintId).toBeNull();
  });

  it('rejects mission from different habitat', () => {
    const otherHabitat = habitatRepo.createHabitat({ name: 'Other' });
    const otherColumn = columnRepo.createColumn({ habitatId: otherHabitat.id, name: 'Backlog', order: 0, requiresClaim: false });
    const otherMission = missionRepo.createMission({ habitatId: otherHabitat.id, columnId: otherColumn.id, title: 'Other Mission', createdBy: 'test' });

    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');

    expect(() => addMissionToSprint(sprint.id, otherMission.id)).toThrow('Mission does not belong to the same habitat as the sprint');
  });
});

describe('updateSprint', () => {
  it('updates name and goal in planning', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const updated = updateSprint(sprint.id, { name: 'Sprint 1.1', goal: 'Ship v0.11' });

    expect(updated.name).toBe('Sprint 1.1');
    expect(updated.goal).toBe('Ship v0.11');
  });

  it('rejects structural changes to active sprint', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    startSprint(sprint.id);

    expect(() => updateSprint(sprint.id, { name: 'Renamed' })).toThrow('Cannot modify name or dates of an active or completed sprint');
  });

  it('allows notes update on active sprint', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    startSprint(sprint.id);

    const updated = updateSprint(sprint.id, { notes: 'Updated notes' });
    expect(updated.notes).toBe('Updated notes');
  });
});

describe('deleteSprint', () => {
  it('deletes a planning sprint and unlinks missions', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    const m1 = createTestMission('Mission');
    addMissionToSprint(sprint.id, m1.id);

    deleteSprint(sprint.id);

    expect(sprintRepo.getById(sprint.id)).toBeNull();
    expect(missionRepo.getMissionById(m1.id)?.sprintId).toBeNull();
  });

  it('rejects deleting an active sprint', () => {
    const sprint = createSprint(habitatId, { name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-14' }, 'user-1');
    startSprint(sprint.id);

    expect(() => deleteSprint(sprint.id)).toThrow('Cannot delete an active sprint');
  });
});
