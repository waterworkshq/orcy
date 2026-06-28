import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import {
  wikiSearch,
  wikiGetPage,
  wikiListPages,
  wikiGetAuthoringContext,
  wikiCreatePage,
  wikiSaveVersion,
  wikiRestoreVersion,
  wikiUpdateMetadata,
  wikiAddLink,
  wikiRemoveLink,
  wikiMarkNoUpdateNeeded,
  wikiTriggerRefresh,
  wikiGetSignalSurface,
} from "./wiki.js";

/** MCP {@link Tool} descriptor registering the `orcy_wiki` tool surface. */
export const WIKI_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_wiki",
  description:
    "Habitat wiki — authored, versioned knowledge pages. Read pages, author pages, manage citations, search, post coverage markers, and surface experience patterns + engineering findings (seed 14).",
  actions: [
    "search",
    "get_page",
    "list_pages",
    "get_authoring_context",
    "create_page",
    "save_version",
    "restore_version",
    "update_metadata",
    "add_link",
    "remove_link",
    "mark_no_update_needed",
    "trigger_refresh",
    "get_signal_surface",
  ],
  sharedParams: {
    habitatId: { type: "string", description: "The UUID of the habitat" },
    pageId: { type: "string", description: "The UUID of the wiki page (most actions)" },
    query: { type: "string", description: "Free-text search query (search action)" },
    title: { type: "string", description: "Wiki page title (create_page, save_version)" },
    content: { type: "string", description: "Wiki page content (create_page, save_version)" },
    editSummary: {
      type: "string",
      description: "One-liner describing the edit (save_version, optional)",
    },
    versionNumber: {
      type: "number",
      description: "Version number to restore (restore_version)",
    },
    parentId: {
      type: ["string", "null"],
      description: "Parent page id (create_page, update_metadata); null = root",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Tag list (create_page, update_metadata)",
    },
    status: {
      type: "string",
      enum: ["draft", "published"],
      description: "Curation status (update_metadata)",
    },
    coverageFrom: {
      type: "string",
      description:
        "ISO datetime — explicit coverage window start for the page-type marker on publish (create_page, update_metadata). Pass the authoring chunk start when publishing scheduler-spawned authoring work.",
    },
    coverageTo: {
      type: "string",
      description:
        "ISO datetime — explicit coverage window end for the page-type marker on publish (create_page, update_metadata). Pass the authoring chunk end when publishing scheduler-spawned authoring work.",
    },
    targetType: {
      type: "string",
      description: "Polymorphic link target type (add_link), e.g. 'mission', 'task', 'pulse'",
    },
    targetId: {
      type: "string",
      description: "Polymorphic link target id (add_link)",
    },
    note: { type: "string", description: "Optional link note (add_link)" },
    linkId: { type: "string", description: "Wiki page link id (remove_link)" },
    from: {
      type: "string",
      description:
        "Coverage window start (mark_no_update_needed, get_authoring_context chunk mode)",
    },
    to: {
      type: "string",
      description: "Coverage window end (mark_no_update_needed, get_authoring_context chunk mode)",
    },
    reason: {
      type: "string",
      description: "Optional reason / note (mark_no_update_needed)",
    },
    tag: { type: "string", description: "Filter by tag (list_pages)" },
    limit: { type: "number", description: "Result limit (search, list_pages)" },
    offset: { type: "number", description: "Result offset (search, list_pages)" },
    domain: {
      type: "string",
      description:
        "Filter signal surface by task domain (get_signal_surface; experience aggregates only — no-op in v0.21)",
    },
    timeWindow: {
      type: "string",
      description:
        "Duration string for recency filter on signal surface (get_signal_surface), e.g. '7 days', '30 days'",
    },
    signalClass: {
      type: "string",
      enum: ["experience", "finding", "both"],
      description: "Which signal sub-surfaces to populate (get_signal_surface); defaults to 'both'",
    },
  },
});

/** Map of MCP action name (e.g. `search`, `get_page`) to the corresponding {@link Handler}. */
export const WIKI_ACTIONS: Record<string, Handler> = {
  search: wikiSearch,
  get_page: wikiGetPage,
  list_pages: wikiListPages,
  get_authoring_context: wikiGetAuthoringContext,
  create_page: wikiCreatePage,
  save_version: wikiSaveVersion,
  restore_version: wikiRestoreVersion,
  update_metadata: wikiUpdateMetadata,
  add_link: wikiAddLink,
  remove_link: wikiRemoveLink,
  mark_no_update_needed: wikiMarkNoUpdateNeeded,
  trigger_refresh: wikiTriggerRefresh,
  get_signal_surface: wikiGetSignalSurface,
};

/** Top-level {@link ToolHandler} that resolves incoming `orcy_wiki` calls to their action handler. */
export const WIKI_DISPATCH_HANDLER = createDispatchHandler(WIKI_ACTIONS);
