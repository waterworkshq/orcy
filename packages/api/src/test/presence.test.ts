import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getSubscriberCount: vi.fn(() => 0),
  },
}));

import {
  joinBoard,
  leaveBoard,
  setViewingTask,
  getBoardPresence,
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

  it('should join a board and broadcast presence.joined', () => {
    joinBoard('board-1', {
      sessionId: 'sess-1',
      type: 'human',
      boardId: 'board-1',
      userId: 'user-1',
      userName: 'Alice',
    });

    expect(mockedPublish).toHaveBeenCalledWith('board-1', expect.objectContaining({
      type: 'presence.joined',
    }));

    const viewers = getBoardPresence('board-1');
    expect(viewers).toHaveLength(1);
    expect(viewers[0].userName).toBe('Alice');
    expect(viewers[0].sessionId).toBe('sess-1');
  });

  it('should leave a board and broadcast presence.left', () => {
    joinBoard('board-1', {
      sessionId: 'sess-1',
      type: 'human',
      boardId: 'board-1',
      userName: 'Alice',
    });
    mockedPublish.mockClear();

    leaveBoard('board-1', 'sess-1');

    expect(mockedPublish).toHaveBeenCalledWith('board-1', expect.objectContaining({
      type: 'presence.left',
    }));
    expect(getBoardPresence('board-1')).toHaveLength(0);
  });

  it('should set viewing task and broadcast presence.refresh', () => {
    joinBoard('board-1', {
      sessionId: 'sess-1',
      type: 'human',
      boardId: 'board-1',
      userName: 'Alice',
    });
    mockedPublish.mockClear();

    setViewingTask('board-1', 'sess-1', 'task-42');

    expect(mockedPublish).toHaveBeenCalledWith('board-1', expect.objectContaining({
      type: 'presence.refresh',
    }));

    const viewers = getBoardPresence('board-1');
    expect(viewers[0].viewingTaskId).toBe('task-42');
  });

  it('should get task viewers', () => {
    joinBoard('board-1', {
      sessionId: 'sess-1',
      type: 'human',
      boardId: 'board-1',
      userName: 'Alice',
    });
    joinBoard('board-1', {
      sessionId: 'sess-2',
      type: 'agent',
      boardId: 'board-1',
      agentName: 'Bot',
    });

    setViewingTask('board-1', 'sess-1', 'task-42');
    setViewingTask('board-1', 'sess-2', 'task-42');

    const taskViewers = getTaskViewers('board-1', 'task-42');
    expect(taskViewers).toHaveLength(2);
  });

  it('should broadcast presence.summary after throttle delay', () => {
    joinBoard('board-1', {
      sessionId: 'sess-1',
      type: 'human',
      boardId: 'board-1',
      userName: 'Alice',
    });

    vi.advanceTimersByTime(5_000);
    mockedPublish.mockClear();

    joinBoard('board-1', {
      sessionId: 'sess-2',
      type: 'human',
      boardId: 'board-1',
      userName: 'Bob',
    });

    expect(mockedPublish).toHaveBeenCalledWith('board-1', expect.objectContaining({
      type: 'presence.joined',
    }));
    mockedPublish.mockClear();

    vi.advanceTimersByTime(5_000);

    expect(mockedPublish).toHaveBeenCalledWith('board-1', expect.objectContaining({
      type: 'presence.summary',
    }));
  });

  it('should cleanup stale entries', () => {
    joinBoard('board-1', {
      sessionId: 'sess-1',
      type: 'human',
      boardId: 'board-1',
      userName: 'Alice',
    });

    const entry = getBoardPresence('board-1')[0];
    expect(entry).toBeDefined();

    vi.advanceTimersByTime(130_000);

    const removed = cleanupStalePresence(120_000);
    expect(removed).toBe(1);
    expect(getBoardPresence('board-1')).toHaveLength(0);
  });

  it('should start and stop cleanup interval', () => {
    joinBoard('board-1', {
      sessionId: 'sess-1',
      type: 'human',
      boardId: 'board-1',
      userName: 'Alice',
    });

    const interval = startPresenceCleanup(10);
    vi.advanceTimersByTime(150_000);
    clearInterval(interval);

    expect(getBoardPresence('board-1')).toHaveLength(0);
  });

  it('should handle leave for non-existent board gracefully', () => {
    expect(() => leaveBoard('nonexistent', 'sess-1')).not.toThrow();
  });

  it('should handle setViewingTask for non-existent session gracefully', () => {
    joinBoard('board-1', {
      sessionId: 'sess-1',
      type: 'human',
      boardId: 'board-1',
      userName: 'Alice',
    });

    expect(() => setViewingTask('board-1', 'nonexistent', 'task-1')).not.toThrow();
  });
});
