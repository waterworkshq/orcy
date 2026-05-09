import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from './factories/task.js';
import { makeAgent } from './factories/agent.js';

vi.mock('../repositories/comment.js', () => ({
  createComment: vi.fn(),
  getCommentById: vi.fn(),
  getCommentsByTaskId: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));

vi.mock('../repositories/commentMention.js', () => ({
  createMentions: vi.fn((items) => items.map((item: any, i: number) => ({ ...item, id: `mention-${i + 1}`, createdAt: '2026-04-10T00:00:00.000Z' }))),
  getMentionsByCommentIds: vi.fn(() => []),
}));

vi.mock('../repositories/user.js', () => ({
  findUsersByUsernamesCaseInsensitive: vi.fn(),
}));

vi.mock('../repositories/agent.js', () => ({
  listAgents: vi.fn(),
}));

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn(),
  getBoardIdForTask: vi.fn().mockReturnValue('board-1'),
}));

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

import { addComment } from '../services/commentService.js';
import * as commentRepo from '../repositories/comment.js';
import * as commentMentionRepo from '../repositories/commentMention.js';
import * as userRepo from '../repositories/user.js';
import * as agentRepo from '../repositories/agent.js';
import * as taskRepo from '../repositories/task.js';
import { sseBroadcaster } from '../sse/broadcaster.js';

describe('comment mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(taskRepo.getTaskById).mockReturnValue(makeTask({ id: 'task-1', title: 'Mention Task' }));
    vi.mocked(commentRepo.createComment).mockReturnValue({
      id: 'comment-1',
      taskId: 'task-1',
      parentId: null,
      authorType: 'human',
      authorId: 'user-author',
      content: 'Hi @alex and @buildbot',
      createdAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    } as ReturnType<typeof commentRepo.createComment>);
  });

  it('creates mentions for exact username and agent-name matches', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([{ id: 'user-1', username: 'alex' }]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([makeAgent({ id: 'agent-1', name: 'buildbot' })]);

    const result = addComment('task-1', 'human', 'user-author', 'Hi @alex and @buildbot');

    expect(commentMentionRepo.createMentions).toHaveBeenCalledWith([
      { commentId: 'comment-1', mentionedType: 'human', mentionedId: 'user-1', mentionText: '@alex' },
      { commentId: 'comment-1', mentionedType: 'agent', mentionedId: 'agent-1', mentionText: '@buildbot' },
    ]);
    expect(result.mentions).toHaveLength(2);
    expect(sseBroadcaster.publish).toHaveBeenCalledWith('board-1', expect.objectContaining({ type: 'task.mentioned' }));
  });

  it('ignores unresolved mention text', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([]);

    const result = addComment('task-1', 'human', 'user-author', 'Ping @nobody');

    expect(commentMentionRepo.createMentions).toHaveBeenCalledWith([]);
    expect(result.mentions).toEqual([]);
  });

  it('matches case-insensitively but preserves original mention text', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([{ id: 'user-2', username: 'Alex' }]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([]);

    const result = addComment('task-1', 'human', 'user-author', 'Hello @aLeX');

    expect(commentMentionRepo.createMentions).toHaveBeenCalledWith([
      { commentId: 'comment-1', mentionedType: 'human', mentionedId: 'user-2', mentionText: '@aLeX' },
    ]);
    expect(result.mentions?.[0]?.mentionText).toBe('@aLeX');
  });
});