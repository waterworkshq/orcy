import * as userRepo from '../repositories/user.js';
import * as agentRepo from '../repositories/agent.js';

const MENTION_REGEX = /(^|\s)@([a-zA-Z0-9._-]{1,50})\b/g;

export function extractMentionTokens(content: string): string[] {
  return [...content.matchAll(MENTION_REGEX)].map((match) => `@${match[2]}`);
}

export interface ResolvedMention {
  mentionedType: 'human' | 'agent';
  mentionedId: string;
  mentionText: string;
  mentionedName: string;
}

export function resolveMentions(content: string): ResolvedMention[] {
  const tokens = [...new Set(extractMentionTokens(content))];
  if (tokens.length === 0) return [];

  const rawNames = tokens.map((token) => token.slice(1));
  const users = userRepo.findUsersByUsernamesCaseInsensitive(rawNames);
  const agents = agentRepo.listAgents();
  const userMap = new Map(users.map((u) => [u.username.toLowerCase(), u]));
  const agentMap = new Map(agents.map((a) => [a.name.toLowerCase(), a]));

  const results: ResolvedMention[] = [];
  for (const token of tokens) {
    const name = token.slice(1).toLowerCase();
    const human = userMap.get(name);
    if (human) {
      results.push({ mentionedType: 'human', mentionedId: human.id, mentionText: token, mentionedName: human.username });
      continue;
    }
    const agent = agentMap.get(name);
    if (agent) {
      results.push({ mentionedType: 'agent', mentionedId: agent.id, mentionText: token, mentionedName: agent.name });
    }
  }
  return results;
}
