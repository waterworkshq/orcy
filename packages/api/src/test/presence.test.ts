import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getSubscriberCount: vi.fn(() => 0),
  },
}));

import {
  joinHabitat,
  leaveHabitat,
  setViewingTask,
  getHabitatPresence,
  getTaskViewers,
  cleanupStalePresence,
  startPresenceCleanup,
  resetPresenceForTesting,
} from '../sse/presence.js';
import { sseBroadcaster } from '../sse/broadcaster.js';

const mockedPublish = vi.mocked(sseBroadcaster.publish);

describe('Presence Module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedPublish.mockClear();
    resetPresenceForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should join a habitat and broadcast presence.joined', () => {
    joinHabitat('habitat-1', {
      sessionId: 'sess-1',
      type: 'human',
      habitatId: 'habitat-1',
      userId: 'user-1',
      userName: 'Alice',
    });

    expect(mockedPublish).toHaveBeenCalledWith('habitat-1', expect.objectContaining({
      type: 'presence.joined',
    }));

    const viewers = getHabitatPresence('habitat-1');
    expect(viewers).toHaveLength(1);
    expect(viewers[0].userName).toBe('Alice');
    expect(viewers[0].sessionId).toBe('sess-1');
  });

  it('should leave a habitat and broadcast presence.left', () => {
    joinHabitat('habitat-1', {
      sessionId: 'sess-1',
      type: 'human',
      habitatId: 'habitat-1',
      userName: 'Alice',
    });
    mockedPublish.mockClear();

    leaveHabitat('habitat-1', 'sess-1');

    expect(mockedPublish).toHaveBeenCalledWith('habitat-1', expect.objectContaining({
      type: 'presence.left',
    }));
    expect(getHabitatPresence('habitat-1')).toHaveLength(0);
  });

  it('should set viewing task and broadcast presence.refresh', () => {
    joinHabitat('habitat-1', {
      sessionId: 'sess-1',
      type: 'human',
      habitatId: 'habitat-1',
      userName: 'Alice',
    });
    mockedPublish.mockClear();

    setViewingTask('habitat-1', 'sess-1', 'task-42');

    expect(mockedPublish).toHaveBeenCalledWith('habitat-1', expect.objectContaining({
      type: 'presence.refresh',
    }));

    const viewers = getHabitatPresence('habitat-1');
    expect(viewers[0].viewingTaskId).toBe('task-42');
  });

  it('should get task viewers', () => {
    joinHabitat('habitat-1', {
      sessionId: 'sess-1',
      type: 'human',
      habitatId: 'habitat-1',
      userName: 'Alice',
    });
    joinHabitat('habitat-1', {
      sessionId: 'sess-2',
      type: 'agent',
      habitatId: 'habitat-1',
      agentName: 'Bot',
    });

    setViewingTask('habitat-1', 'sess-1', 'task-42');
    setViewingTask('habitat-1', 'sess-2', 'task-42');

    const taskViewers = getTaskViewers('habitat-1', 'task-42');
    expect(taskViewers).toHaveLength(2);
  });

  it('should broadcast presence.summary after throttle delay', () => {
    joinHabitat('habitat-1', {
      sessionId: 'sess-1',
      type: 'human',
      habitatId: 'habitat-1',
      userName: 'Alice',
    });

    vi.advanceTimersByTime(5_000);
    mockedPublish.mockClear();

    joinHabitat('habitat-1', {
      sessionId: 'sess-2',
      type: 'human',
      habitatId: 'habitat-1',
      userName: 'Bob',
    });

    expect(mockedPublish).toHaveBeenCalledWith('habitat-1', expect.objectContaining({
      type: 'presence.joined',
    }));
    mockedPublish.mockClear();

    vi.advanceTimersByTime(5_000);

    expect(mockedPublish).toHaveBeenCalledWith('habitat-1', expect.objectContaining({
      type: 'presence.summary',
    }));
  });

  it('should cleanup stale entries', () => {
    joinHabitat('habitat-1', {
      sessionId: 'sess-1',
      type: 'human',
      habitatId: 'habitat-1',
      userName: 'Alice',
    });

    const entry = getHabitatPresence('habitat-1')[0];
    expect(entry).toBeDefined();

    vi.advanceTimersByTime(130_000);

    const removed = cleanupStalePresence(120_000);
    expect(removed).toBe(1);
    expect(getHabitatPresence('habitat-1')).toHaveLength(0);
  });

  it('should start and stop cleanup interval', () => {
    joinHabitat('habitat-1', {
      sessionId: 'sess-1',
      type: 'human',
      habitatId: 'habitat-1',
      userName: 'Alice',
    });

    const interval = startPresenceCleanup(10);
    vi.advanceTimersByTime(150_000);
    clearInterval(interval);

    expect(getHabitatPresence('habitat-1')).toHaveLength(0);
  });

  it('should handle leave for non-existent habitat gracefully', () => {
    expect(() => leaveHabitat('nonexistent', 'sess-1')).not.toThrow();
  });

  it('should handle setViewingTask for non-existent session gracefully', () => {
    joinHabitat('habitat-1', {
      sessionId: 'sess-1',
      type: 'human',
      habitatId: 'habitat-1',
      userName: 'Alice',
    });

    expect(() => setViewingTask('habitat-1', 'nonexistent', 'task-1')).not.toThrow();
  });
});
