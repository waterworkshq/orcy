import { z } from 'zod';

export const mentionTokenSchema = z.object({
  text: z.string().min(2).max(100),
  kind: z.enum(['human', 'agent']),
});

export const commentMentionSchema = z.object({
  id: z.string().uuid(),
  commentId: z.string().uuid(),
  mentionedType: z.enum(['human', 'agent']),
  mentionedId: z.string().uuid(),
  mentionText: z.string(),
  createdAt: z.string(),
  mentionedName: z.string().optional(),
});

export type CommentMentionInput = z.infer<typeof commentMentionSchema>;