import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { formatRelativeTime } from '../../lib/formatting.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { MessageSquare, Bot, User, Pencil, Trash2, Reply, X, Send } from 'lucide-react';
import { MarkdownContent } from '../ui/MarkdownContent.js';
import { useMissionComments } from '../../lib/useHabitatData.js';
import type { MissionComment } from '../../types/index.js';

interface MissionCommentSectionProps {
  missionId: string;
}

export function MissionCommentSection({ missionId }: MissionCommentSectionProps) {
  const qc = useQueryClient();
  const { data: commentsData = { comments: [], total: 0 }, isLoading: loading } = useMissionComments(missionId);
  const [comments, setComments] = useState<MissionComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [replyingTo, setReplyingTo] = useState<{ id: string } | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  React.useEffect(() => {
    setComments(commentsData.comments);
    setLoaded(true);
  }, [commentsData.comments]);

  async function handleSubmit() {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      const result = await api.missionComments.create(missionId, {
        content: content.trim(),
        parentId: replyingTo?.id,
      });
      setComments((prev) => [result.comment, ...prev]);
      setContent('');
      setReplyingTo(null);
      notify.success('Comment added');
      qc.invalidateQueries({ queryKey: queryKeys.missionComments.list(missionId) });
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
      const result = await api.missionComments.update(missionId, commentId, { content: editContent.trim() });
      setComments((prev) => prev.map((c) => (c.id === commentId ? result.comment : c)));
      setEditingId(null);
      setEditContent('');
      notify.success('Comment updated');
      qc.invalidateQueries({ queryKey: queryKeys.missionComments.list(missionId) });
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(commentId: string) {
    try {
      await api.missionComments.delete(missionId, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      notify.success('Comment deleted');
      qc.invalidateQueries({ queryKey: queryKeys.missionComments.list(missionId) });
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setDeleteTargetId(null);
    }
  }

  const getAuthorLabel = (comment: MissionComment) =>
    comment.authorType === 'agent'
      ? comment.authorId.slice(0, 8)
      : 'Human';

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="animate-pulse space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 bg-[var(--surface-container-high)] rounded" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-col gap-3">
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Add a comment about this mission..."
                rows={3}
                className="w-full bg-[var(--surface-container-high)] text-[var(--on-surface)] text-sm p-3 rounded-lg border border-[var(--outline-variant)] resize-none focus:outline-none focus:border-[var(--primary)] placeholder:text-[var(--on-surface-variant)]/60"
                disabled={submitting}
              />
              <div className="flex justify-end">
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSubmit}
                  disabled={submitting || !content.trim()}
                >
                  <Send className="h-3.5 w-3.5 mr-1.5" />
                  {submitting ? 'Posting...' : 'Post'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {comments.length === 0 && loaded && (
          <div className="text-center py-12 text-[var(--on-surface-variant)]">
            <MessageSquare className="h-8 w-8 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No comments yet on this mission</p>
          </div>
        )}

        {comments.map((comment) => (
          <Card key={comment.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  {comment.authorType === 'agent' ? (
                    <Bot className="h-4 w-4 text-[var(--tertiary)]" />
                  ) : (
                    <User className="h-4 w-4 text-[var(--primary)]" />
                  )}
                  <span className="text-xs font-semibold text-[var(--on-surface)]">
                    {getAuthorLabel(comment)}
                  </span>
                  <span className="text-[10px] text-[var(--on-surface-variant)]">
                    {formatRelativeTime(comment.createdAt, { fallbackToDate: true })}
                  </span>
                  {comment.createdAt !== comment.updatedAt && (
                    <span className="text-[9px] italic text-[var(--on-surface-variant)]/60">(edited)</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      setReplyingTo({ id: comment.id });
                    }}
                    className="p-1 rounded text-[var(--on-surface-variant)]/60 hover:text-[var(--primary)] hover:bg-[var(--surface-container-high)] transition-colors"
                    title="Reply"
                  >
                    <Reply className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(comment.id);
                      setEditContent(comment.content);
                    }}
                    className="p-1 rounded text-[var(--on-surface-variant)]/60 hover:text-[var(--primary)] hover:bg-[var(--surface-container-high)] transition-colors"
                    title="Edit"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => setDeleteTargetId(comment.id)}
                    className="p-1 rounded text-[var(--on-surface-variant)]/60 hover:text-[var(--error)] hover:bg-[var(--surface-container-high)] transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>

              {editingId === comment.id ? (
                <div className="space-y-2">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={3}
                    className="w-full bg-[var(--surface-container-high)] text-[var(--on-surface)] text-sm p-2 rounded border border-[var(--outline-variant)] resize-none focus:outline-none focus:border-[var(--primary)]"
                    disabled={submitting}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => handleEdit(comment.id)}
                      disabled={submitting || !editContent.trim()}
                    >
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingId(null);
                        setEditContent('');
                      }}
                    >
                      <X className="h-3.5 w-3.5 mr-1" />
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none text-[var(--on-surface-variant)]">
                  <MarkdownContent content={comment.content} />
                </div>
              )}

              {replyingTo?.id === comment.id && (
                <div className="mt-3 flex gap-2">
                  <input
                    type="text"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Write a reply..."
                    className="flex-1 bg-[var(--surface-container-high)] text-[var(--on-surface)] text-sm p-2 rounded border border-[var(--outline-variant)] focus:outline-none focus:border-[var(--primary)] placeholder:text-[var(--on-surface-variant)]/60"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSubmit();
                      }
                    }}
                    disabled={submitting}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setReplyingTo(null)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <ConfirmDialog
        open={deleteTargetId !== null}
        onConfirm={() => deleteTargetId && handleDelete(deleteTargetId)}
        onCancel={() => setDeleteTargetId(null)}
        title="Delete Comment"
        description="This comment will be permanently removed. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
