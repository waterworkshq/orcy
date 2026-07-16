import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMission } from './factories/mission.js';

vi.mock('../repositories/mission.js', () => ({
  updateMission: vi.fn(),
  getMissionById: vi.fn(),
}));

vi.mock('../repositories/event.js', () => ({
  createMissionEvent: vi.fn(),
}));

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: { publish: vi.fn(), subscribe: vi.fn() },
}));

import * as missionRepo from '../repositories/mission.js';
import { updateMission } from '../services/featureService.js';

const mockUpdateMission = vi.mocked(missionRepo.updateMission);
const mockGetMissionById = vi.mocked(missionRepo.getMissionById);

describe('missionService.updateMission — optimistic locking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMissionById.mockReturnValue(makeMission({ id: 'f1', habitatId: 'b1', isArchived: false }));
  });

  it('passes version as expectedVersion to the repo', () => {
    const mission = makeMission({ id: 'f1', habitatId: 'b1', version: 5 });
    mockUpdateMission.mockReturnValue({ success: true, mission });

    const result = updateMission('f1', { title: 'Updated', version: 4 }, 'user1');

    expect(result).toEqual({ success: true, mission });
    expect(mockUpdateMission).toHaveBeenCalledWith('f1', { title: 'Updated' }, 4);
  });

  it('returns versionMismatch error from repo when version does not match', () => {
    mockUpdateMission.mockReturnValue({
      success: false,
      versionMismatch: true,
      currentVersion: 7,
    });

    const result = updateMission('f1', { title: 'Updated', version: 3 }, 'user1');

    expect(result).toEqual({
      success: false,
      versionMismatch: true,
      currentVersion: 7,
    });
    expect(mockUpdateMission).toHaveBeenCalledWith('f1', { title: 'Updated' }, 3);
  });

  it('works without version (backward compatible)', () => {
    const mission = makeMission({ id: 'f1', habitatId: 'b1', version: 2 });
    mockUpdateMission.mockReturnValue({ success: true, mission });

    const result = updateMission('f1', { title: 'Updated' }, 'user1');

    expect(result).toEqual({ success: true, mission });
    expect(mockUpdateMission).toHaveBeenCalledWith('f1', { title: 'Updated' }, undefined);
  });

  it('strips version from updateFields before passing to repo', () => {
    const mission = makeMission({ id: 'f1', habitatId: 'b1', version: 3 });
    mockUpdateMission.mockReturnValue({ success: true, mission });

    updateMission('f1', { title: 'New', description: 'desc', version: 2 }, 'user1');

    const repoInput = mockUpdateMission.mock.calls[0][1];
    expect(repoInput).not.toHaveProperty('version');
    expect(repoInput).toEqual({ title: 'New', description: 'desc' });
  });
});
