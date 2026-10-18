import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Save, Eye, Pencil, AlertTriangle, Tag, X } from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { notify } from "../../lib/toast.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import { AuthoringPanel } from "./AuthoringPanel.js";
import { LinkPicker } from "./LinkPicker.js";
import type { WikiPage, WikiPageStatus } from "../../types/index.js";

interface WikiEditorProps {
  habitatId: string;
  mode: "create" | "edit";
  pageId?: string;
  onDone: (pageId: string) => void;
  onCancel: () => void;
}

interface DraftValues {
  title: string;
  content: string;
  parentId: string;
  tags: string[];
  status: WikiPageStatus;
}

export function WikiEditor(props: WikiEditorProps) {
  return <WikiEditorSession key={JSON.stringify([props.habitatId, props.mode, props.pageId])} {...props} />;
}

function WikiEditorSession({ habitatId, mode, pageId, onDone, onCancel }: WikiEditorProps) {
  const queryClient = useQueryClient();
  const isEdit = mode === "edit" && !!pageId;
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const [draft, setDraft] = useState(() => {
    const values: DraftValues = { title: "", content: "", parentId: "", tags: [], status: "draft" };
    return { values, saved: values, conflicts: {} as Partial<Record<keyof DraftValues, boolean>> };
  });
  const pendingMetadata = useRef(false);
  const pendingText = useRef(false);
  const [failedWriteRevision, setFailedWriteRevision] = useState(0);
  const { title, content, parentId, tags, status } = draft.values;
  function setField<K extends keyof DraftValues>(field: K, value: DraftValues[K]) {
    setDraft((current) => ({
      ...current,
      values: { ...current.values, [field]: value },
      conflicts: {
        ...current.conflicts,
        [field]: JSON.stringify(value) === JSON.stringify(current.saved[field]) ? false : current.conflicts[field],
      },
    }));
  }
  const [editSummary, setEditSummary] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [preview, setPreview] = useState(false);

  const { data: pageData, isLoading: pageLoading } = useQuery({
    queryKey: queryKeys.wiki.page(habitatId, pageId ?? "new"),
    queryFn: () => wikiApi.getPage(habitatId, pageId!),
    enabled: isEdit,
  });

  const { data: allPages } = useQuery({
    queryKey: queryKeys.wiki.pages(habitatId),
    queryFn: () => wikiApi.listPages(habitatId),
    staleTime: 30 * 1000,
  });

  useEffect(() => {
    if (isEdit && pageData) {
      const saved: DraftValues = {
        title: pageData.title, content: pageData.content, parentId: pageData.parentId ?? "",
        tags: pageData.tags, status: pageData.status,
      };
      setDraft((current) => {
        const next = {
          values: { ...current.values }, saved: { ...current.saved }, conflicts: { ...current.conflicts },
        };
        for (const field of Object.keys(saved) as (keyof DraftValues)[]) {
          // A refetch may observe our write before the mutation acknowledges its submitted fields.
          const pending = field === "title" || field === "content" ? pendingText.current : pendingMetadata.current;
          if (pending) continue;
          const clean = JSON.stringify(current.values[field]) === JSON.stringify(current.saved[field]);
          const matchesServer = JSON.stringify(current.values[field]) === JSON.stringify(saved[field]);
          if (clean) Object.assign(next.values, { [field]: saved[field] });
          if (clean || matchesServer) next.conflicts[field] = false;
          else if (JSON.stringify(current.saved[field]) !== JSON.stringify(saved[field])) next.conflicts[field] = true;
          Object.assign(next.saved, { [field]: saved[field] });
        }
        return next;
      });
    }
  }, [isEdit, pageData, failedWriteRevision]);

  const contentChanged = isEdit
    ? title !== draft.saved.title || content !== draft.saved.content
    : title.trim().length > 0 && content.trim().length > 0;
  const metadataChanged =
    isEdit &&
    (parentId !== draft.saved.parentId ||
      JSON.stringify(tags) !== JSON.stringify(draft.saved.tags) ||
      status !== draft.saved.status);

  const createMutation = useMutation({
    mutationFn: () =>
      wikiApi.createPage(habitatId, {
        title: title.trim(),
        content,
        parentId: parentId || null,
        tags,
        status,
      }),
    onSuccess: (page: WikiPage) => {
      if (!active.current) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(habitatId) });
      notify.success("Page created");
      onDone(page.id);
    },
    onError: (err) => { if (active.current) notify.error((err as Error).message); },
  });

  const saveMutation = useMutation({
    mutationFn: (submitted: { title: string; content: string; editSummary: string }) =>
      wikiApi.saveVersion(habitatId, pageId!, {
        title: submitted.title.trim(), content: submitted.content,
        editSummary: submitted.editSummary.trim() || undefined,
      }),
    onSuccess: (page, submitted) => {
      if (!active.current) return;
      setDraft((current) => ({
        conflicts: { ...current.conflicts, title: false, content: false },
        saved: { ...current.saved, title: page.title, content: page.content },
        values: {
          ...current.values,
          title: current.values.title === submitted.title ? page.title : current.values.title,
          content: current.values.content === submitted.content ? page.content : current.values.content,
        },
      }));
      pendingText.current = false;
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.versions(habitatId, pageId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(habitatId) });
      setEditSummary((current) => current === submitted.editSummary ? "" : current);
      notify.success("New version saved");
    },
    onError: (err) => {
      if (!active.current) return;
      pendingText.current = false;
      // Replay any GET skipped while saving, even if a later GET is structurally identical.
      setFailedWriteRevision((revision) => revision + 1);
      notify.error((err as Error).message);
    },
  });

  const metadataMutation = useMutation({
    mutationFn: (submitted: Pick<DraftValues, "parentId" | "tags" | "status">) =>
      wikiApi.updatePageMetadata(habitatId, pageId!, { ...submitted, parentId: submitted.parentId || null }),
    onSuccess: (page, submitted) => {
      if (!active.current) return;
      setDraft((current) => ({
        conflicts: { ...current.conflicts, parentId: false, tags: false, status: false },
        saved: { ...current.saved, parentId: page.parentId ?? "", tags: page.tags, status: page.status },
        values: {
          ...current.values,
          parentId: current.values.parentId === submitted.parentId ? page.parentId ?? "" : current.values.parentId,
          tags: JSON.stringify(current.values.tags) === JSON.stringify(submitted.tags) ? page.tags : current.values.tags,
          status: current.values.status === submitted.status ? page.status : current.values.status,
        },
      }));
      pendingMetadata.current = false;
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(habitatId) });
      notify.success("Metadata updated");
    },
    onError: (err) => {
      if (!active.current) return;
      pendingMetadata.current = false;
      setFailedWriteRevision((revision) => revision + 1);
      notify.error((err as Error).message);
    },
  });

  const saving = createMutation.isPending || saveMutation.isPending;
  const textConflict = draft.conflicts.title || draft.conflicts.content;
  const metadataConflict = draft.conflicts.parentId || draft.conflicts.tags || draft.conflicts.status;
  const canSave = contentChanged && !saving && !textConflict;

  function handleSave() {
    if (!canSave) return;
    if (isEdit) {
      pendingText.current = true;
      saveMutation.mutate({ title, content, editSummary });
    } else {
      createMutation.mutate();
    }
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (t && !tags.includes(t)) {
      setField("tags", [...tags, t]);
    }
    setTagInput("");
  }

  function removeTag(t: string) {
    setField("tags", tags.filter((x) => x !== t));
  }

  if (isEdit && pageLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--on-surface-variant)]" />
      </div>
    );
  }

  const parentOptions = (allPages ?? []).filter((p) => p.id !== pageId);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--on-surface-variant)] hover:text-[var(--on-surface)] transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Cancel
        </button>
        <span className="text-xs font-semibold text-[var(--on-surface)] ml-auto">
          {isEdit ? "Edit Page" : "New Page"}
        </span>
      </div>

      {(Object.keys(draft.conflicts) as (keyof DraftValues)[]).filter((field) => draft.conflicts[field]).map((field) => {
        const label = { title: "Title", content: "Content", parentId: "Parent page", tags: "Tags", status: "Status" }[field];
        return <div key={field} role="alert" className="rounded-md border border-[var(--outline-variant)] p-3 text-xs space-x-3">
          <span>{label} changed on the server.</span>
          <button type="button" onClick={() => setDraft((current) => ({
            ...current, conflicts: { ...current.conflicts, [field]: false },
          }))}>Keep my {label}</button>
          <button type="button" onClick={() => setDraft((current) => ({
            ...current,
            values: { ...current.values, [field]: current.saved[field] },
            conflicts: { ...current.conflicts, [field]: false },
          }))}>Use server {label}</button>
        </div>;
      })}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-3">
        <div className="space-y-3 min-w-0">
          <input
            type="text"
            value={title}
            onChange={(e) => setField("title", e.target.value)}
            placeholder="Page title…"
            className="w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] px-3 py-2 text-base font-semibold text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          />

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPreview(false)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                !preview
                  ? "bg-[var(--surface-container-high)] text-[var(--on-surface)]"
                  : "text-[var(--on-surface-variant)] hover:bg-[var(--surface-container)]"
              }`}
            >
              <Pencil className="h-3.5 w-3.5" /> Write
            </button>
            <button
              type="button"
              onClick={() => setPreview(true)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                preview
                  ? "bg-[var(--surface-container-high)] text-[var(--on-surface)]"
                  : "text-[var(--on-surface-variant)] hover:bg-[var(--surface-container)]"
              }`}
            >
              <Eye className="h-3.5 w-3.5" /> Preview
            </button>
          </div>

          {preview ? (
            <div className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] p-3 min-h-[300px] max-h-[60vh] overflow-y-auto">
              {content.trim() ? (
                <MarkdownContent content={content} />
              ) : (
                <p className="text-xs text-[var(--on-surface-variant)] italic">
                  Nothing to preview yet.
                </p>
              )}
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setField("content", e.target.value)}
              placeholder="Write page content in markdown…"
              className="w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] px-3 py-2 text-sm text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] min-h-[300px] max-h-[60vh] resize-y font-mono"
            />
          )}

          <div className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] p-3 space-y-2.5">
            <label className="block">
              <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
                Parent page
              </span>
              <select
                value={parentId}
                onChange={(e) => setField("parentId", e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--on-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
              >
                <option value="">— Root page (no parent) —</option>
                {parentOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
                Status
              </span>
              <select
                value={status}
                onChange={(e) => setField("status", e.target.value as WikiPageStatus)}
                className="mt-1 w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--on-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
              </select>
            </label>

            <div>
              <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider flex items-center gap-1">
                <Tag className="h-3 w-3" /> Tags
              </span>
              <div className="mt-1 flex flex-wrap gap-1">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-0.5 bg-[var(--surface-container-high)] text-[var(--on-surface-variant)] text-[10px] px-1.5 py-0.5 rounded-full"
                  >
                    #{t}
                    <button
                      type="button"
                      onClick={() => removeTag(t)}
                      className="hover:text-[var(--error)]"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
                placeholder="Add tag…"
                className="mt-1 w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
              />
            </div>

            {isEdit && (
              <label className="block">
                <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
                  Edit summary (optional)
                </span>
                <input
                  type="text"
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  placeholder="Briefly describe this change…"
                  className="mt-1 w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                />
              </label>
            )}
          </div>

          {isEdit && <LinkPicker habitatId={habitatId} pageId={pageId!} />}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-[var(--primary)] text-[var(--on-primary)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {isEdit ? "Save version" : "Create page"}
            </button>
            {isEdit && metadataChanged && !saveMutation.isPending && (
              <button
                type="button"
                onClick={() => {
                  pendingMetadata.current = true;
                  metadataMutation.mutate({ parentId, tags: [...tags], status });
                }}
                disabled={metadataMutation.isPending || !!metadataConflict}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-[var(--outline-variant)] text-[var(--on-surface)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50"
              >
                {metadataMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save metadata
              </button>
            )}
            {!canSave && !isEdit && (
              <span className="text-[10px] text-[var(--on-surface-variant)]">
                Enter a title and some content to save.
              </span>
            )}
            {saveMutation.isError && (
              <span className="text-[10px] text-[var(--error)] inline-flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Save failed
              </span>
            )}
          </div>
        </div>

        <aside className="lg:border-l lg:border-[var(--outline-variant)] lg:pl-3">
          <AuthoringPanel
            habitatId={habitatId}
            pageId={isEdit ? pageId : undefined}
            contentLength={content.length}
          />
        </aside>
      </div>
    </div>
  );
}
