import React, { useState } from 'react';
import { useBoardStore } from '../../store/habitatStore.js';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { formatRelativeTime } from '../../lib/formatting.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { MessageSquare, Bot, User, Pencil, Trash2, Reply, X, Send } from 'lucide-react';
import { MarkdownContent } from '../ui/MarkdownContent.js';
import { injectMentionLinks } from '../../lib/commentMentions.js';
import type { TaskComment } from '../../types/index.js';

interface CommentSectionProps {
  taskId: string;
  initialComments?: TaskComment[];
}

export function CommentSection({ taskId, initialComments = [] }: CommentSectionProps) {
  const { setComments, addComment, removeComment, agents } = useBoardStore();
  const [taskComments, setTaskComments] = useState<TaskComment[]>(initialComments);
  const [loading] = useState(false);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [replyingTo, setReplyingTo] = useState<{ id: string; authorName: string } | null>(null);

  async function handleSubmit() {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      const result = await api.comments.create(taskId, {
        content: content.trim(),
        parentId: replyingTo?.id,
      });
      addComment(result.comment);
      setTaskComments((prev) => [result.comment, ...prev]);
      setContent('');
      setReplyingTo(null);
      notify.success('Comment added');
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEdit(commentId: string) {
    if (!editContent.trim()) return;
    setSubmitting(true);
    try {
      const result = await api.comments.update(taskId, commentId, { content: editContent.trim() });
      setComments(taskId, taskComments.map((c) => (c.id === commentId ? result.comment : c)));
      setTaskComments((prev) => prev.map((c) => (c.id === commentId ? result.comment : c)));
      setEditingId(null);
      setEditContent('');
      notify.success('Comment updated');
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(commentId: string) {
    if (!confirm('Delete this comment?')) return;
    try {
      await api.comments.delete(taskId, commentId);
      removeComment(taskId, commentId);
      setTaskComments((prev) => prev.filter((c) => c.id !== commentId));
      notify.success('Comment deleted');
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  function getAuthorName(comment: TaskComment): string {
    if (comment.authorType === 'agent') {
      const agent = agents.find((a) => a.id === comment.authorId);
      return agent?.name || 'Agent';
    }
    return 'Human';
  }

  function formatTime(dateStr: string): string {
    return formatRelativeTime(dateStr, { fallbackToDate: true });
  }

  function isEdited(createdAt: string, updatedAt: string): boolean {
    return createdAt !== updatedAt;
  }

  const topLevelComments = taskComments.filter((c) => !c.parentId);
  const getReplies = (parentId: string) => taskComments.filter((c) => c.parentId === parentId);

  return (
    <Card>
      <CardHeader className="p-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageSquare className="h-4 w-4" />
          Comments
          {taskComments.length > 0 && (
            <span className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-xs">{taskComments.length}</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-4">
        {loading && (
          <div className="flex justify-center py-4">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}

        {!loading && topLevelComments.length === 0 && (
          <p className="text-xs text-muted-foreground py-4 text-center">No comments yet.</p>
        )}

        {topLevelComments.map((comment) => (
          <div key={comment.id} className="space-y-2">
            <CommentItem
              comment={comment}
              authorName={getAuthorName(comment)}
              isEdited={isEdited(comment.createdAt, comment.updatedAt)}
              formatTime={formatTime}
              onEdit={() => {
                setEditingId(comment.id);
                setEditContent(comment.content);
              }}
              onDelete={() => handleDelete(comment.id)}
              onReply={() => setReplyingTo({ id: comment.id, authorName: getAuthorName(comment) })}
              editingId={editingId}
              editContent={editContent}
              setEditContent={setEditContent}
              onSaveEdit={() => handleEdit(comment.id)}
              onCancelEdit={() => {
                setEditingId(null);
                setEditContent('');
              }}
              submitting={submitting}
            />
            {getReplies(comment.id).map((reply) => (
              <div key={reply.id} className="ml-6 border-l-2 border-muted pl-3">
                <CommentItem
                  comment={reply}
                  authorName={getAuthorName(reply)}
                  isEdited={isEdited(reply.createdAt, reply.updatedAt)}
                  formatTime={formatTime}
                  onEdit={() => {
                    setEditingId(reply.id);
                    setEditContent(reply.content);
                  }}
                  onDelete={() => handleDelete(reply.id)}
                  onReply={() => setReplyingTo({ id: comment.id, authorName: getAuthorName(comment) })}
                  editingId={editingId}
                  editContent={editContent}
                  setEditContent={setEditContent}
                  onSaveEdit={() => handleEdit(reply.id)}
                  onCancelEdit={() => {
                    setEditingId(null);
                    setEditContent('');
                  }}
                  submitting={submitting}
                  isReply
                />
              </div>
            ))}
          </div>
        ))}

        <div className="border-t pt-3">
          {replyingTo && (
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Reply className="h-3 w-3" />
              <span>Replying to {replyingTo.authorName}</span>
              <button
                onClick={() => setReplyingTo(null)}
                className="ml-auto p-1 hover:bg-accent rounded"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Add a comment..."
              className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-muted-foreground">Markdown supported</span>
            <Button size="sm" onClick={handleSubmit} disabled={submitting || !content.trim()}>
              <Send className="h-3 w-3 mr-1" />
              Post
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface CommentItemProps {
  comment: TaskComment;
  authorName: string;
  isEdited: boolean;
  formatTime: (date: string) => string;
  onEdit: () => void;
  onDelete: () => void;
  onReply: () => void;
  editingId: string | null;
  editContent: string;
  setEditContent: (content: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  submitting: boolean;
  isReply?: boolean;
}

function CommentItem({
  comment,
  authorName,
  isEdited,
  formatTime,
  onEdit,
  onDelete,
  onReply,
  editingId,
  editContent,
  setEditContent,
  onSaveEdit,
  onCancelEdit,
  submitting,
  isReply,
}: CommentItemProps) {
  const isEditing = editingId === comment.id;

  return (
    <div className="group">
      <div className="flex items-start gap-2">
        <div className={`mt-0.5 rounded-full p-1.5 ${comment.authorType === 'agent' ? 'bg-[var(--agent-purple)]/15' : 'bg-[var(--agent-blue)]/15'}`}>
          {comment.authorType === 'agent' ? (
            <Bot className={`h-3 w-3 text-purple-600`} />
          ) : (
            <User className={`h-3 w-3 text-blue-600`} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{authorName}</span>
            <span className="text-xs text-muted-foreground">
              {formatTime(isEditing ? comment.updatedAt : comment.createdAt)}
            </span>
            {isEdited && !isEditing && (
              <span className="text-xs text-muted-foreground">(edited)</span>
            )}
          </div>

          {isEditing ? (
            <div className="mt-1 space-y-2">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
                rows={3}
                autoFocus
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={onSaveEdit} disabled={submitting}>
                  Save
                </Button>
                <Button size="sm" variant="outline" onClick={onCancelEdit}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-1">
                <MarkdownContent content={injectMentionLinks(comment.content, comment.mentions ?? [])} className="text-sm" />
              </div>
              <div className="flex items-center gap-3 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={onReply}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Reply className="h-3 w-3" />
                  Reply
                </button>
                <button
                  onClick={onEdit}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </button>
                <button
                  onClick={onDelete}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-red-600"
                >
                  <Trash2 className="h-3 w-3" />
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
