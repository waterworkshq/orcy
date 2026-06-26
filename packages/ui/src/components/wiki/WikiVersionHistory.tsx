import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Eye, AlertTriangle } from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { MarkdownContent } from "../ui/MarkdownContent.js";
import type { WikiPageVersion } from "../../types/index.js";

interface WikiVersionHistoryProps {
  habitatId: string;
  pageId: string;
}

export function WikiVersionHistory({ habitatId, pageId }: WikiVersionHistoryProps) {
  const queryClient = useQueryClient();
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  const { data: versions, isLoading } = useQuery({
    queryKey: queryKeys.wiki.versions(habitatId, pageId),
    queryFn: () => wikiApi.listVersions(habitatId, pageId),
    staleTime: 30 * 1000,
  });

  const restoreMutation = useMutation({
    mutationFn: (versionNumber: number) => wikiApi.restoreVersion(habitatId, pageId, versionNumber),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.versions(habitatId, pageId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(habitatId) });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
      </div>
    );
  }

  const list = versions ?? [];
  if (list.length === 0) {
    return (
      <div className="text-xs text-[var(--on-surface-variant)] py-3 text-center">
        No version history.
      </div>
    );
  }

  const sorted = [...list].sort((a, b) => b.versionNumber - a.versionNumber);

  return (
    <div className="rounded-lg border border-[var(--outline-variant)] bg-[var(--surface-container-low)] divide-y divide-[var(--outline-variant)]">
      <div className="px-3 py-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold text-[var(--on-surface-variant)] uppercase tracking-wider">
          Version history ({sorted.length})
        </span>
        {restoreMutation.isError && (
          <span className="text-[10px] text-[var(--error)] inline-flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> Restore failed
          </span>
        )}
      </div>
      {sorted.map((version) => (
        <VersionRow
          key={version.id}
          version={version}
          habitatId={habitatId}
          pageId={pageId}
          expanded={expandedVersion === version.versionNumber}
          onToggle={() =>
            setExpandedVersion((cur) =>
              cur === version.versionNumber ? null : version.versionNumber,
            )
          }
          isRestoring={
            restoreMutation.isPending && restoreMutation.variables === version.versionNumber
          }
          onRestore={() => restoreMutation.mutate(version.versionNumber)}
        />
      ))}
    </div>
  );
}

function VersionRow({
  version,
  habitatId,
  pageId,
  expanded,
  onToggle,
  isRestoring,
  onRestore,
}: {
  version: WikiPageVersion;
  habitatId: string;
  pageId: string;
  expanded: boolean;
  onToggle: () => void;
  isRestoring: boolean;
  onRestore: () => void;
}) {
  const { data: fullVersion, isLoading } = useQuery({
    queryKey: [...queryKeys.wiki.versions(habitatId, pageId), "view", version.versionNumber],
    queryFn: () => wikiApi.getVersion(habitatId, pageId, version.versionNumber),
    enabled: expanded,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-[var(--on-surface-variant)] shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-[var(--on-surface-variant)] shrink-0" />
          )}
          <span className="text-xs font-semibold text-[var(--on-surface)] shrink-0">
            v{version.versionNumber}
          </span>
          <span className="text-xs text-[var(--on-surface-variant)] truncate">
            {version.editSummary ?? version.title}
          </span>
        </button>
        <span className="text-[10px] text-[var(--on-surface-variant)] shrink-0">
          {version.editedBy.slice(0, 8)} · {new Date(version.createdAt).toLocaleDateString()}
        </span>
        {expanded ? (
          <button
            type="button"
            onClick={onRestore}
            disabled={isRestoring}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--primary)] hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-50 shrink-0"
          >
            {isRestoring ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            Restore
          </button>
        ) : (
          <Eye className="h-3 w-3 text-[var(--on-surface-variant)] opacity-50 shrink-0" />
        )}
      </div>
      {expanded && (
        <div className="px-3 pb-3">
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--on-surface-variant)]" />
            </div>
          ) : (
            <div className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface)] p-3 max-h-80 overflow-y-auto">
              <MarkdownContent content={fullVersion?.content ?? version.content} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
