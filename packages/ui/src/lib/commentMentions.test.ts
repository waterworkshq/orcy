import { describe, expect, it } from 'vitest';
import { injectMentionLinks } from './commentMentions.js';

describe('injectMentionLinks', () => {
  it('returns original content when there are no mentions', () => {
    expect(injectMentionLinks('plain text', [])).toBe('plain text');
  });

  it('replaces mention text with mention scheme links', () => {
    expect(
      injectMentionLinks('Hello @alex', [
        {
          id: 'mention-1',
          commentId: 'comment-1',
          mentionedType: 'human',
          mentionedId: 'user-1',
          mentionText: '@alex',
          createdAt: '2026-04-10T00:00:00.000Z',
        },
      ])
    ).toBe('Hello [@alex](mention://human/user-1)');
  });

  it('handles multiple mentions in the same string', () => {
    expect(
      injectMentionLinks('Hi @alex and @bot', [
        { id: 'm1', commentId: 'c1', mentionedType: 'human', mentionedId: 'u1', mentionText: '@alex', createdAt: '' },
        { id: 'm2', commentId: 'c1', mentionedType: 'agent', mentionedId: 'a1', mentionText: '@bot', createdAt: '' },
      ])
    ).toBe('Hi [@alex](mention://human/u1) and [@bot](mention://agent/a1)');
  });
});