import * as userRepo from "../repositories/user.js";
import * as agentRepo from "../repositories/agent.js";

const MENTION_REGEX = /(^|\s)@([a-zA-Z0-9._-]{1,50})\b/g;

/** Extracts all `@mention` tokens from comment text, preserving the leading `@`. */
export function extractMentionTokens(content: string): string[] {
  return [...content.matchAll(MENTION_REGEX)].map((match) => `@${match[2]}`);
}

/** A mention token resolved to a known human user or agent within the current habitat. */
export interface ResolvedMention {
  mentionedType: "human" | "agent";
  mentionedId: string;
  mentionText: string;
  mentionedName: string;
}

/** Resolves deduplicated `@mention` tokens in comment text to matching users and agents via case-insensitive name lookup. Unknown mentions are dropped. */
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
      results.push({
        mentionedType: "human",
        mentionedId: human.id,
        mentionText: token,
        mentionedName: human.username,
      });
      continue;
    }
    const agent = agentMap.get(name);
    if (agent) {
      results.push({
        mentionedType: "agent",
        mentionedId: agent.id,
        mentionText: token,
        mentionedName: agent.name,
      });
    }
  }
  return results;
}
