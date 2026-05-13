import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeAgent } from './factories/agent.js';

vi.mock('../repositories/user.js', () => ({
  findUsersByUsernamesCaseInsensitive: vi.fn(),
}));

vi.mock('../repositories/agent.js', () => ({
  listAgents: vi.fn(),
}));

import { extractMentionTokens, resolveMentions } from '../services/commentHelper.js';
import * as userRepo from '../repositories/user.js';
import * as agentRepo from '../repositories/agent.js';

describe('extractMentionTokens', () => {
  it('extracts single @mention', () => {
    expect(extractMentionTokens('Hello @alex')).toEqual(['@alex']);
  });

  it('extracts multiple @mentions', () => {
    expect(extractMentionTokens('Hi @alex and @buildbot')).toEqual(['@alex', '@buildbot']);
  });

  it('extracts @mention at start of line', () => {
    expect(extractMentionTokens('@alex please review')).toEqual(['@alex']);
  });

  it('returns empty array for no mentions', () => {
    expect(extractMentionTokens('just some text')).toEqual([]);
  });

  it('does not match email addresses', () => {
    expect(extractMentionTokens('email@domain.com is not a mention')).toEqual([]);
  });

  it('handles bare @ with no name', () => {
    expect(extractMentionTokens('hello @ there')).toEqual([]);
  });

  it('deduplicates tokens from caller (resolveMentions handles this)', () => {
    const tokens = extractMentionTokens('@alex @alex @alex');
    expect(tokens).toEqual(['@alex', '@alex', '@alex']);
  });
});

describe('resolveMentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a human @mention', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([{ id: 'user-1', username: 'alex' }]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([]);

    const results = resolveMentions('Hello @alex');
    expect(results).toEqual([
      { mentionedType: 'human', mentionedId: 'user-1', mentionText: '@alex', mentionedName: 'alex' },
    ]);
  });

  it('resolves an agent @mention', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([makeAgent({ id: 'agent-1', name: 'buildbot' })]);

    const results = resolveMentions('Ping @buildbot');
    expect(results).toEqual([
      { mentionedType: 'agent', mentionedId: 'agent-1', mentionText: '@buildbot', mentionedName: 'buildbot' },
    ]);
  });

  it('resolves mixed human and agent mentions', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([{ id: 'user-1', username: 'alex' }]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([makeAgent({ id: 'agent-1', name: 'buildbot' })]);

    const results = resolveMentions('Hi @alex and @buildbot');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ mentionedType: 'human', mentionedId: 'user-1', mentionText: '@alex', mentionedName: 'alex' });
    expect(results[1]).toEqual({ mentionedType: 'agent', mentionedId: 'agent-1', mentionText: '@buildbot', mentionedName: 'buildbot' });
  });

  it('matches case-insensitively', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([{ id: 'user-2', username: 'Alex' }]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([]);

    const results = resolveMentions('yo @aLeX');
    expect(results).toEqual([
      { mentionedType: 'human', mentionedId: 'user-2', mentionText: '@aLeX', mentionedName: 'Alex' },
    ]);
  });

  it('deduplicates repeated mentions', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([{ id: 'user-1', username: 'alex' }]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([]);

    const results = resolveMentions('@alex @alex @alex');
    expect(results).toHaveLength(1);
  });

  it('returns empty array for no mentions', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([]);

    expect(resolveMentions('no one here')).toEqual([]);
  });

  it('ignores unresolved mentions', () => {
    vi.mocked(userRepo.findUsersByUsernamesCaseInsensitive).mockReturnValue([]);
    vi.mocked(agentRepo.listAgents).mockReturnValue([]);

    expect(resolveMentions('ping @nobody')).toEqual([]);
  });
});
