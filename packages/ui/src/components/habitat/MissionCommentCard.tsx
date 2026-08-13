import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Pencil, Reply, Send, Trash2, User, X } from "lucide-react";
import { api } from "../../api/index.js";
import { notify } from "../../lib/toast.js";
import { formatRelativeTime } from "../../lib/formatting.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { Button } from "../ui/Button.js";
import { ConfirmDialog } from "../ui/ConfirmDialog.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import { missionCommentAuthorLabel } from "./missionCommentAuthor.js";
import type { MissionComment } from "../../types/index.js";

interface MissionCommentCardProps {
  missionId: string;
  comment: MissionComment;
}

export function MissionCommentCard({ missionId, comment }: MissionCommentCardProps) {
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);
  const [replying, setReplying] = useState(false);
  const [replyContent, setReplyContent] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleEdit() {
    if (!editContent.trim()) return;
    setSubmitting(true);
    try {
      await api.missionComments.update(missionId, comment.id, { content: editContent.trim() });
      setEditing(false);
      notify.success("Comment updated");
      await qc.invalidateQueries({ queryKey: queryKeys.missionComments.list(missionId) });
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    try {
      await api.missionComments.delete(missionId, comment.id);
      notify.success("Comment deleted");
      await qc.invalidateQueries({ queryKey: queryKeys.missionComments.list(missionId) });
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setConfirmDelete(false);
    }
  }

  async function handleReply() {
    if (!replyContent.trim()) return;
    setSubmitting(true);
    try {
      await api.missionComments.create(missionId, {
        content: replyContent.trim(),
        parentId: comment.id,
      });
      setReplyContent("");
      setReplying(false);
      notify.success("Comment added");
      await qc.invalidateQueries({ queryKey: queryKeys.missionComments.list(missionId) });
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container)] p-3">
      <div className="mb-2 flex items-start justify-between">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--on-surface-variant)]">
            Comment
          </p>
          <p className="flex items-center gap-2 text-[10px] text-[var(--on-surface-variant)]">
            {comment.authorType === "agent" ? (
              <Bot className="h-3.5 w-3.5 text-[var(--tertiary)]" />
            ) : (
              <User className="h-3.5 w-3.5 text-[var(--primary)]" />
            )}
            {missionCommentAuthorLabel(comment)} ·{" "}
            {formatRelativeTime(comment.createdAt, { fallbackToDate: true })}
            {comment.createdAt !== comment.updatedAt ? (
              <span className="italic opacity-60">(edited)</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="rounded p-1 text-[var(--on-surface-variant)]/60 hover:bg-[var(--surface-container-high)] hover:text-[var(--primary)]"
            title="Reply to comment"
            aria-label="Reply to comment"
          >
            <Reply className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setEditContent(comment.content);
            }}
            className="rounded p-1 text-[var(--on-surface-variant)]/60 hover:bg-[var(--surface-container-high)] hover:text-[var(--primary)]"
            title="Edit comment"
            aria-label="Edit comment"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="rounded p-1 text-[var(--on-surface-variant)]/60 hover:bg-[var(--surface-container-high)] hover:text-[var(--error)]"
            title="Delete comment"
            aria-label="Delete comment"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={3}
            className="w-full resize-none rounded border border-[var(--outline-variant)] bg-[var(--surface-container-high)] p-2 text-sm"
            disabled={submitting}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={handleEdit}
              disabled={submitting || !editContent.trim()}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setEditContent(comment.content);
              }}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="prose prose-sm max-w-none text-[var(--on-surface-variant)]">
          <MarkdownContent content={comment.content} />
        </div>
      )}

      {replying ? (
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            placeholder="Write a reply..."
            className="flex-1 rounded border border-[var(--outline-variant)] bg-[var(--surface-container-high)] p-2 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleReply();
              }
            }}
            disabled={submitting}
          />
          <Button variant="ghost" size="sm" onClick={() => setReplying(false)}>
            <X className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReply}
            disabled={submitting || !replyContent.trim()}
          >
            <Send className="mr-1 h-3.5 w-3.5" />
            Reply
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
        title="Delete Comment"
        description="This comment will be permanently removed. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </article>
  );
}
