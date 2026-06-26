import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Link2,
  Link2Off,
  Tag,
  History,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Calendar,
  User,
  Pencil,
  Trash2,
} from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { notify } from "../../lib/toast.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/Dialog.js";
import { WikiVersionHistory } from "./WikiVersionHistory.js";
import type { WikiPageLinkWithDangling } from "../../types/index.js";

interface WikiPageViewerProps {
  habitatId: string;
  pageId: string;
  onBack: () => void;
  onEdit?: () => void;
}

export function WikiPageViewer({ habitatId, pageId, onBack, onEdit }: WikiPageViewerProps) {
  const queryClient = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [stayGoneReason, setStayGoneReason] = useState("");
  const {
    data: page,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.wiki.page(habitatId, pageId),
    queryFn: () => wikiApi.getPage(habitatId, pageId),
    staleTime: 30 * 1000,
  });

  const deleteMutation = useMutation({
    mutationFn: (opts: { stayGone?: boolean; reason?: string }) =>
      wikiApi.deletePage(habitatId, pageId, opts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(habitatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId) });
      notify.success("Page deleted");
      setDeleteOpen(false);
      onBack();
    },
    onError: (err) => notify.error((err as Error).message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--on-surface-variant)]" />
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-[var(--error)] gap-2">
        <AlertTriangle className="h-8 w-8 opacity-60" />
        <span className="text-sm">Failed to load wiki page.</span>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-[var(--primary)] hover:underline"
        >
          Back to browser
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--on-surface-variant)] hover:text-[var(--on-surface)] transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to browser
        </button>
        <button
          type="button"
          onClick={() => setShowHistory((s) => !s)}
          className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold text-[var(--on-surface-variant)] hover:text-[var(--on-surface)] hover:bg-[var(--surface-container-high)] transition-colors"
        >
          <History className="h-3.5 w-3.5" />
          {showHistory ? "Hide history" : "Version history"}
          {showHistory ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold text-[var(--on-primary)] bg-[var(--primary)] hover:opacity-90 transition-opacity"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        )}
        <button
          type="button"
          onClick={() => setDeleteOpen(true)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
      </div>

      <div className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container-low)] p-4 space-y-3">
        <div className="flex flex-wrap items-start gap-2">
          <h2 className="text-xl font-bold text-[var(--on-surface)] flex-1 min-w-0">
            {page.title}
          </h2>
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${
              page.status === "published"
                ? "bg-[var(--tertiary)]/15 text-[var(--tertiary)]"
                : "bg-[var(--surface-container-high)] text-[var(--on-surface-variant)]"
            }`}
          >
            {page.status}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[10px] text-[var(--on-surface-variant)]">
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" />
            by {page.lastUpdatedBy.slice(0, 8)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {new Date(page.lastUpdatedAt).toLocaleString()}
          </span>
          <span>v{page.currentVersionNumber}</span>
          {page.tags.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Tag className="h-3 w-3" />
              {page.tags.map((t) => `#${t}`).join(" ")}
            </span>
          )}
        </div>
      </div>

      {showHistory && <WikiVersionHistory habitatId={habitatId} pageId={pageId} />}

      <div className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface)] p-4">
        <MarkdownContent content={page.content} />
      </div>

      {page.links.length > 0 && (
        <div>
          <h3 className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider mb-2 flex items-center gap-1">
            <Link2 className="h-3 w-3" /> Citations ({page.links.length})
          </h3>
          <div className="space-y-1">
            {page.links.map((link) => (
              <CitationRow key={link.id} link={link} />
            ))}
          </div>
        </div>
      )}

      <DeletePageDialog
        open={deleteOpen}
        title={page.title}
        deleting={deleteMutation.isPending}
        stayGoneReason={stayGoneReason}
        onReasonChange={setStayGoneReason}
        onCancel={() => {
          setDeleteOpen(false);
          setStayGoneReason("");
        }}
        onPlainDelete={() => deleteMutation.mutate({})}
        onStayGoneDelete={() =>
          deleteMutation.mutate({ stayGone: true, reason: stayGoneReason || undefined })
        }
      />
    </div>
  );
}

function DeletePageDialog({
  open,
  title,
  deleting,
  stayGoneReason,
  onReasonChange,
  onCancel,
  onPlainDelete,
  onStayGoneDelete,
}: {
  open: boolean;
  title: string;
  deleting: boolean;
  stayGoneReason: string;
  onReasonChange: (v: string) => void;
  onCancel: () => void;
  onPlainDelete: () => void;
  onStayGoneDelete: () => void;
}) {
  return (
    <Dialog open={open} onClose={onCancel}>
      <DialogHeader>
        <DialogTitle>Delete "{title}"?</DialogTitle>
        <DialogDescription>
          Choose how to delete this page. The wiki cadence may re-create pages that are
          plain-deleted.
        </DialogDescription>
      </DialogHeader>
      <div className="mt-4 space-y-3">
        <div className="rounded-md border border-[var(--outline-variant)] p-3 space-y-2">
          <p className="text-xs text-[var(--on-surface)]">
            <strong>Delete</strong> — removes the page. The wiki cadence may re-create this page on
            its next run.
          </p>
          <button
            type="button"
            onClick={onPlainDelete}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--outline-variant)] text-[var(--on-surface)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete
          </button>
        </div>
        <div className="rounded-md border border-[var(--error)]/40 bg-[var(--error)]/5 p-3 space-y-2">
          <p className="text-xs text-[var(--on-surface)]">
            <strong>Delete permanently</strong> — inserts a no-update-needed marker that prevents
            the cadence from re-creating this page.
          </p>
          <input
            type="text"
            value={stayGoneReason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Optional reason…"
            className="w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          />
          <button
            type="button"
            onClick={onStayGoneDelete}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--error)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete permanently (prevent re-creation)
          </button>
        </div>
      </div>
      <DialogFooter className="mt-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={deleting}
          className="px-3 py-1.5 rounded-md text-xs font-semibold text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </DialogFooter>
    </Dialog>
  );
}

function CitationRow({ link }: { link: WikiPageLinkWithDangling }) {
  const dangling = link.dangling === true;
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
        dangling
          ? "border-[var(--error)]/40 bg-[var(--error)]/5"
          : "border-[var(--outline-variant)] bg-[var(--surface-container-low)]"
      }`}
    >
      {dangling ? (
        <Link2Off className="h-3.5 w-3.5 text-[var(--error)] shrink-0" />
      ) : (
        <Link2 className="h-3.5 w-3.5 text-[var(--tertiary)] shrink-0" />
      )}
      <span className="text-[10px] uppercase tracking-wider text-[var(--on-surface-variant)] shrink-0">
        {link.targetType}
      </span>
      <span
        className={`font-mono text-[var(--on-surface)] truncate ${
          dangling ? "line-through opacity-60" : ""
        }`}
      >
        {link.targetId}
      </span>
      {dangling && (
        <span className="text-[9px] font-bold uppercase text-[var(--error)] shrink-0">deleted</span>
      )}
      {link.linkNote && (
        <span className="text-[var(--on-surface-variant)] truncate ml-auto italic">
          {link.linkNote}
        </span>
      )}
    </div>
  );
}
