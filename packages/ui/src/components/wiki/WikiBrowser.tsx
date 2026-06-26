import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Search,
  X,
  AlertTriangle,
  Plus,
} from "lucide-react";
import { wikiApi } from "../../api/domains/wiki.js";
import { queryKeys } from "../../lib/queryKeys.js";
import type { WikiPage, WikiPageStatus, WikiSearchHit } from "../../types/index.js";

interface WikiBrowserProps {
  habitatId: string;
  onCreatePage?: () => void;
}

const STATUS_FILTERS: Array<"all" | WikiPageStatus> = ["all", "published", "draft"];

export function WikiBrowser({ habitatId, onCreatePage }: WikiBrowserProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState<"all" | WikiPageStatus>("all");
  const [tagFilter, setTagFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const isSearching = debouncedQuery.length >= 2;

  const { data: pages, isLoading } = useQuery({
    queryKey: queryKeys.wiki.pages(habitatId),
    queryFn: () => wikiApi.listPages(habitatId),
    staleTime: 30 * 1000,
    enabled: !isSearching,
  });

  const { data: searchResults, isLoading: searchLoading } = useQuery({
    queryKey: queryKeys.wiki.search(habitatId, debouncedQuery),
    queryFn: () => wikiApi.search(habitatId, debouncedQuery),
    staleTime: 15 * 1000,
    enabled: isSearching,
  });

  const allPages = pages ?? [];

  const tags = useMemo(() => {
    const set = new Set<string>();
    allPages.forEach((p) => p.tags.forEach((t) => set.add(t)));
    return Array.from(set).toSorted();
  }, [allPages]);

  const filtered = useMemo(() => {
    return allPages.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (tagFilter && !p.tags.includes(tagFilter)) return false;
      return true;
    });
  }, [allPages, statusFilter, tagFilter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  const openPage = (pageId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", pageId);
    setSearchParams(next, { replace: false });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {onCreatePage && (
          <button
            type="button"
            onClick={onCreatePage}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold bg-[var(--primary)] text-[var(--on-primary)] hover:opacity-90 transition-opacity shrink-0"
          >
            <Plus className="h-3.5 w-3.5" /> New Page
          </button>
        )}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--on-surface-variant)]" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search pages (min 2 chars)…"
            className="w-full rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] pl-8 pr-7 py-1.5 text-sm text-[var(--on-surface)] placeholder:text-[var(--on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--on-surface-variant)] hover:text-[var(--on-surface)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | WikiPageStatus)}
          className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] px-2 py-1.5 text-xs text-[var(--on-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] px-2 py-1.5 text-xs text-[var(--on-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
        >
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
      </div>

      {isSearching ? (
        <SearchResults
          habitatId={habitatId}
          results={searchResults ?? []}
          loading={searchLoading}
          onOpen={openPage}
        />
      ) : isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
        </div>
      ) : tree.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--on-surface-variant)] gap-2">
          <FileText className="h-6 w-6 opacity-30" />
          <span className="text-xs">
            {allPages.length === 0
              ? "No wiki pages yet. Pages are authored by agents during missions."
              : "No pages match the current filters."}
          </span>
        </div>
      ) : (
        <div className="space-y-0.5">
          {tree.map((node) => (
            <PageTreeNode key={node.page.id} node={node} depth={0} onOpen={openPage} />
          ))}
        </div>
      )}
    </div>
  );
}

interface TreeNode {
  page: WikiPage;
  children: TreeNode[];
}

function buildTree(pages: WikiPage[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  pages.forEach((p) => byId.set(p.id, { page: p, children: [] }));
  const roots: TreeNode[] = [];
  byId.forEach((node) => {
    if (node.page.parentId && byId.has(node.page.parentId)) {
      byId.get(node.page.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

function PageTreeNode({
  node,
  depth,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  onOpen: (pageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1.5 hover:bg-[var(--surface-container)] transition-colors group"
        style={{ paddingLeft: `${depth * 16 + 6}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-[var(--on-surface-variant)] hover:text-[var(--on-surface)]"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-3.5" />
        )}
        <button
          type="button"
          onClick={() => onOpen(node.page.id)}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
        >
          <FileText
            className={`h-3.5 w-3.5 shrink-0 ${
              node.page.status === "draft"
                ? "text-[var(--on-surface-variant)]"
                : "text-[var(--primary)]"
            }`}
          />
          <span className="truncate text-sm text-[var(--on-surface)] group-hover:underline">
            {node.page.title}
          </span>
        </button>
        <span
          className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${
            node.page.status === "published"
              ? "bg-[var(--tertiary)]/15 text-[var(--tertiary)]"
              : "bg-[var(--surface-container-high)] text-[var(--on-surface-variant)]"
          }`}
        >
          {node.page.status}
        </span>
        {node.page.tags.length > 0 && (
          <span className="text-[9px] text-[var(--on-surface-variant)] shrink-0 hidden sm:inline">
            {node.page.tags.map((t) => `#${t}`).join(" ")}
          </span>
        )}
      </div>
      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <PageTreeNode key={child.page.id} node={child} depth={depth + 1} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchResults({
  habitatId: _habitatId,
  results,
  loading,
  onOpen,
}: {
  habitatId: string;
  results: WikiSearchHit[];
  loading: boolean;
  onOpen: (pageId: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--on-surface-variant)]" />
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-[var(--on-surface-variant)] gap-2">
        <AlertTriangle className="h-6 w-6 opacity-30" />
        <span className="text-xs">No pages matched the search.</span>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-[var(--on-surface-variant)] uppercase tracking-wider">
        {results.length} result{results.length !== 1 ? "s" : ""}
      </p>
      {results.map((hit) => (
        <button
          key={hit.id}
          type="button"
          onClick={() => onOpen(hit.id)}
          className="w-full text-left rounded-md border border-[var(--outline-variant)] bg-[var(--surface-container-low)] hover:bg-[var(--surface-container)] p-2.5 transition-colors"
        >
          <p className="text-sm font-medium text-[var(--on-surface)] truncate">{hit.title}</p>
          {hit.excerpt && (
            <p className="text-xs text-[var(--on-surface-variant)] line-clamp-2 mt-0.5">
              {hit.excerpt}
            </p>
          )}
        </button>
      ))}
    </div>
  );
}
