import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2, Link2Off, Plus, Loader2, AlertTriangle, X } from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { notify } from "../../lib/toast.js";
import { WIKI_LINK_TARGET_TYPES } from "@orcy/shared";
import type { WikiLinkTargetType, WikiPageLinkWithDangling } from "../../types/index.js";

interface LinkPickerProps {
  habitatId: string;
  pageId: string;
}

export function LinkPicker({ habitatId, pageId }: LinkPickerProps) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [targetType, setTargetType] = useState<WikiLinkTargetType>("task");
  const [targetId, setTargetId] = useState("");
  const [note, setNote] = useState("");

  const { data: links, isLoading } = useQuery({
    queryKey: [...queryKeys.wiki.page(habitatId, pageId), "links"],
    queryFn: () => wikiApi.listLinks(habitatId, pageId),
    staleTime: 30 * 1000,
  });

  const addMutation = useMutation({
    mutationFn: () =>
      wikiApi.addLink(habitatId, pageId, { targetType, targetId, note: note || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId) });
      setAdding(false);
      setTargetId("");
      setNote("");
      notify.success("Citation added");
    },
    onError: (err) => notify.error((err as Error).message),
  });

  const removeMutation = useMutation({
    mutationFn: (linkId: string) => wikiApi.removeLink(habitatId, pageId, linkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId) });
      notify.success("Citation removed");
    },
    onError: (err) => notify.error((err as Error).message),
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider flex items-center gap-1">
          <Link2 className="h-3 w-3" /> Citations {(links ?? []).length > 0 && `(${links!.length})`}
        </h4>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--primary)] hover:bg-[var(--surface-container-high)] transition-colors"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] p-2.5 space-y-2">
          <div className="flex gap-1.5">
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as WikiLinkTargetType)}
              className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] px-1.5 py-1 text-[10px] text-[var(--on-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
            >
              {WIKI_LINK_TARGET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="Target ID…"
              className="flex-1 min-w-0 rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] px-2 py-1 text-[10px] text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
            />
          </div>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note…"
            className="w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] px-2 py-1 text-[10px] text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => addMutation.mutate()}
              disabled={!targetId.trim() || addMutation.isPending}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-[var(--primary)] text-[var(--on-primary)] hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {addMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Add citation
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setTargetId("");
                setNote("");
              }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold text-[var(--on-surface-variant)] hover:bg-[var(--surface-container-high)] transition-colors"
            >
              <X className="h-3 w-3" /> Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--on-surface-variant)]" />
        </div>
      ) : (links ?? []).length === 0 && !adding ? (
        <p className="text-[10px] text-[var(--on-surface-variant)] italic">No citations yet.</p>
      ) : (
        <div className="space-y-1">
          {(links ?? []).map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              removing={removeMutation.isPending && removeMutation.variables === link.id}
              onRemove={() => removeMutation.mutate(link.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LinkRow({
  link,
  removing,
  onRemove,
}: {
  link: WikiPageLinkWithDangling;
  removing: boolean;
  onRemove: () => void;
}) {
  const dangling = link.dangling === true;
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] transition-colors ${
        dangling
          ? "border-[var(--error)]/40 bg-[var(--error)]/5"
          : "border-[var(--outline-variant)] bg-[var(--surface-container-low)]"
      }`}
    >
      {dangling ? (
        <Link2Off className="h-3 w-3 text-[var(--error)] shrink-0" />
      ) : (
        <Link2 className="h-3 w-3 text-[var(--tertiary)] shrink-0" />
      )}
      <span className="uppercase tracking-wider text-[var(--on-surface-variant)] shrink-0 text-[9px]">
        {link.targetType}
      </span>
      <span
        className={`font-mono text-[var(--on-surface)] truncate flex-1 ${
          dangling ? "line-through opacity-60" : ""
        }`}
      >
        {link.targetId}
      </span>
      {dangling && (
        <span className="text-[8px] font-bold uppercase text-[var(--error)] shrink-0">deleted</span>
      )}
      {link.linkNote && (
        <span className="text-[var(--on-surface-variant)] truncate italic hidden sm:inline">
          {link.linkNote}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        className="text-[var(--error)] hover:bg-[var(--error)]/10 rounded p-0.5 transition-colors disabled:opacity-50 shrink-0"
        title="Remove citation"
      >
        {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
      </button>
    </div>
  );
}
