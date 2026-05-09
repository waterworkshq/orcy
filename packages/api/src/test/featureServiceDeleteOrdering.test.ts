import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFeature } from './factories/feature.js';

vi.mock('../repositories/feature.js', () => ({
  getFeatureById: vi.fn(),
  deleteFeature: vi.fn(),
  getFeaturesByDependency: vi.fn(),
}));

vi.mock('../repositories/event.js', () => ({
  createFeatureEvent: vi.fn(),
}));

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: { publish: vi.fn(), subscribe: vi.fn() },
}));

import * as featureRepo from '../repositories/feature.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { deleteFeature } from '../services/featureService.js';

const mockGetFeatureById = featureRepo.getFeatureById as ReturnType<typeof vi.fn>;
const mockDeleteFeature = featureRepo.deleteFeature as ReturnType<typeof vi.fn>;
const mockGetFeaturesByDependency = featureRepo.getFeaturesByDependency as ReturnType<typeof vi.fn>;
const mockPublish = sseBroadcaster.publish as ReturnType<typeof vi.fn>;

describe('featureService.deleteFeature — SSE broadcast ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes from DB before broadcasting SSE event', () => {
    mockGetFeatureById.mockReturnValue(makeFeature({ id: 'f1', boardId: 'b1' }));
    mockGetFeaturesByDependency.mockReturnValue([]);
    mockDeleteFeature.mockReturnValue(undefined);

    const callOrder: string[] = [];
    mockDeleteFeature.mockImplementation(() => { callOrder.push('delete'); });
    mockPublish.mockImplementation(() => { callOrder.push('broadcast'); });

    const result = deleteFeature('f1');

    expect(result).toEqual({ success: true });
    expect(callOrder).toEqual(['delete', 'broadcast']);
  });

  it('does not broadcast SSE if delete throws', () => {
    mockGetFeatureById.mockReturnValue(makeFeature({ id: 'f1', boardId: 'b1' }));
    mockGetFeaturesByDependency.mockReturnValue([]);
    mockDeleteFeature.mockImplementation(() => { throw new Error('db error'); });

    expect(() => deleteFeature('f1')).toThrow('db error');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns not_found when feature does not exist', () => {
    mockGetFeatureById.mockReturnValue(null);

    const result = deleteFeature('nonexistent');

    expect(result).toEqual({ success: false, reason: 'not_found' });
    expect(mockDeleteFeature).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('returns has_dependents when feature has dependents', () => {
    mockGetFeatureById.mockReturnValue(makeFeature({ id: 'f1', boardId: 'b1' }));
    mockGetFeaturesByDependency.mockReturnValue([makeFeature({ id: 'f2' })]);

    const result = deleteFeature('f1');

    expect(result).toEqual({ success: false, reason: 'has_dependents' });
    expect(mockDeleteFeature).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
