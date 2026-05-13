import React, { useState } from 'react';
import { api } from '../../api/index.js';
import { notify } from '../../lib/toast.js';
import { formatRelativeTime } from '../../lib/formatting.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { Button } from '../ui/Button.js';
import { MessageSquare, Bot, User, Pencil, Trash2, Reply, X, Send } from 'lucide-react';
import { MarkdownContent } from '../ui/MarkdownContent.js';
import type { FeatureComment } from '../../types/index.js';

interface FeatureCommentSectionProps {
  featureId: string;
}

export function FeatureCommentSection({ featureId }: FeatureCommentSectionProps) {
  const [comments, setComments] = useState<FeatureComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [replyingTo, setReplyingTo] = useState<{ id: string } | null>(null);

  async function loadComments() {
    setLoading(true);
    try {
      const result = await api.featureComments.list(featureId);
      setComments(result.comments);
      setLoaded(true);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    loadComments();
  }, [featureId]);

  async function handleSubmit() {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      const result = await api.featureComments.create(featureId, {
        content: content.trim(),
        parentId: replyingTo?.id,
      });
      setComments((prev) => [result.comment, ...prev]);
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
      const result = await api.featureComments.update(featureId, commentId, { content: editContent.trim() });
      setComments((prev) => prev.map((c) => (c.id === commentId ? result.comment : c)));
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
      await api.featureComments.delete(featureId, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
      notify.success('Comment deleted');
    } catch (err) {
      notify.error((err as Error).message);
    }
  }

  const getAuthorLabel = (comment: FeatureComment) =>
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
                    onClick={() => handleDelete(comment.id)}
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
    </div>
  );
}
