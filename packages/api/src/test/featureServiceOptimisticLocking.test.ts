import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFeature } from './factories/feature.js';

vi.mock('../repositories/feature.js', () => ({
  updateFeature: vi.fn(),
  getFeatureById: vi.fn(),
}));

vi.mock('../repositories/event.js', () => ({
  createFeatureEvent: vi.fn(),
}));

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: { publish: vi.fn(), subscribe: vi.fn() },
}));

import * as featureRepo from '../repositories/feature.js';
import { updateFeature } from '../services/featureService.js';

const mockUpdateFeature = vi.mocked(featureRepo.updateFeature);
const mockGetFeatureById = vi.mocked(featureRepo.getFeatureById);

describe('featureService.updateFeature — optimistic locking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFeatureById.mockReturnValue(makeFeature({ id: 'f1', boardId: 'b1', isArchived: false }));
  });

  it('passes version as expectedVersion to the repo', () => {
    const feature = makeFeature({ id: 'f1', boardId: 'b1', version: 5 });
    mockUpdateFeature.mockReturnValue({ success: true, feature });

    const result = updateFeature('f1', { title: 'Updated', version: 4 }, 'user1');

    expect(result).toEqual({ success: true, feature });
    expect(mockUpdateFeature).toHaveBeenCalledWith('f1', { title: 'Updated' }, 4);
  });

  it('returns versionMismatch error from repo when version does not match', () => {
    mockUpdateFeature.mockReturnValue({
      success: false,
      versionMismatch: true,
      currentVersion: 7,
    });

    const result = updateFeature('f1', { title: 'Updated', version: 3 }, 'user1');

    expect(result).toEqual({
      success: false,
      versionMismatch: true,
      currentVersion: 7,
    });
    expect(mockUpdateFeature).toHaveBeenCalledWith('f1', { title: 'Updated' }, 3);
  });

  it('works without version (backward compatible)', () => {
    const feature = makeFeature({ id: 'f1', boardId: 'b1', version: 2 });
    mockUpdateFeature.mockReturnValue({ success: true, feature });

    const result = updateFeature('f1', { title: 'Updated' }, 'user1');

    expect(result).toEqual({ success: true, feature });
    expect(mockUpdateFeature).toHaveBeenCalledWith('f1', { title: 'Updated' }, undefined);
  });

  it('strips version from updateFields before passing to repo', () => {
    const feature = makeFeature({ id: 'f1', boardId: 'b1', version: 3 });
    mockUpdateFeature.mockReturnValue({ success: true, feature });

    updateFeature('f1', { title: 'New', description: 'desc', version: 2 }, 'user1');

    const repoInput = mockUpdateFeature.mock.calls[0][1];
    expect(repoInput).not.toHaveProperty('version');
    expect(repoInput).toEqual({ title: 'New', description: 'desc' });
  });
});
