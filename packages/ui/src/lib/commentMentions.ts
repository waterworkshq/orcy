import type { TaskCommentMention } from '../types/index.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function injectMentionLinks(content: string, mentions: TaskCommentMention[] = []): string {
  if (!content || mentions.length === 0) return content;

  let next = content;
  for (const mention of mentions) {
    const scheme = `mention://${mention.mentionedType}/${mention.mentionedId}`;
    const replacement = `[${mention.mentionText}](${scheme})`;
    const regex = new RegExp(`(^|\\s)(${escapeRegExp(mention.mentionText)})(?=\\b)`, 'g');
    next = next.replace(regex, (_match, prefix, token) => `${prefix}${replacement}`);
  }
  return next;
}