import { WIKI_LINK_TARGET_TYPES } from "@orcy/shared";
import type { WikiClient } from "../api/interfaces.js";

/**
 * @requires WikiClient
 */
export async function wikiSearch(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  const query = args.query;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!query) return { error: "Missing required parameter: query" };
  const opts: { limit?: number; offset?: number } = {};
  if (args.limit !== undefined) opts.limit = Number(args.limit);
  if (args.offset !== undefined) opts.offset = Number(args.offset);
  return client.searchWiki(habitatId, query, opts);
}

/**
 * @requires WikiClient
 */
export async function wikiGetPage(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  const pageId = args.pageId;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!pageId) return { error: "Missing required parameter: pageId" };
  return client.getWikiPage(habitatId, pageId);
}

/**
 * @requires WikiClient
 */
export async function wikiListPages(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  const filters: { parentId?: string | null; tag?: string; status?: string } = {};
  if (args.parentId !== undefined) filters.parentId = args.parentId;
  if (args.tag !== undefined) filters.tag = args.tag;
  if (args.status !== undefined) filters.status = args.status;
  return client.listWikiPages(habitatId, filters);
}

/**
 * @requires WikiClient
 *
 * Stub — backed by `wikiAugmentationService` (Phase 5, seed 10). The two
 * modes (delta-on-edit for existing pages, chunk-bounded for new pages)
 * will land together. For now the action is registered so the tool surface
 * is complete; agents see the action exists and a clear "not yet
 * implemented" error.
 */
export async function wikiGetAuthoringContext(_client: WikiClient, _args: Record<string, any>) {
  return {
    error:
      "Authoring context is not yet implemented. It will be available after the wiki augmentation service ships in a future update.",
  };
}

/**
 * @requires WikiClient
 */
export async function wikiCreatePage(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  const title = args.title;
  const content = args.content;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!title) return { error: "Missing required parameter: title" };
  if (content === undefined || content === null) {
    return { error: "Missing required parameter: content" };
  }
  const input: { title: string; content: string; parentId?: string | null; tags?: string[] } = {
    title,
    content,
  };
  if (args.parentId !== undefined) input.parentId = args.parentId;
  if (args.tags !== undefined) input.tags = args.tags;
  return client.createWikiPage(habitatId, input);
}

/**
 * @requires WikiClient
 */
export async function wikiSaveVersion(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  const pageId = args.pageId;
  const title = args.title;
  const content = args.content;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!pageId) return { error: "Missing required parameter: pageId" };
  if (!title) return { error: "Missing required parameter: title" };
  if (content === undefined || content === null) {
    return { error: "Missing required parameter: content" };
  }
  const input: { title: string; content: string; editSummary?: string } = { title, content };
  if (args.editSummary !== undefined) input.editSummary = args.editSummary;
  return client.saveWikiVersion(habitatId, pageId, input);
}

/**
 * @requires WikiClient
 */
export async function wikiRestoreVersion(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  const pageId = args.pageId;
  const versionNumber = args.versionNumber;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!pageId) return { error: "Missing required parameter: pageId" };
  if (versionNumber === undefined || versionNumber === null) {
    return { error: "Missing required parameter: versionNumber" };
  }
  return client.restoreWikiVersion(habitatId, pageId, Number(versionNumber));
}

/**
 * @requires WikiClient
 */
export async function wikiUpdateMetadata(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  const pageId = args.pageId;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!pageId) return { error: "Missing required parameter: pageId" };
  const patch: { parentId?: string | null; tags?: string[]; status?: "draft" | "published" } = {};
  if (args.parentId !== undefined) patch.parentId = args.parentId;
  if (args.tags !== undefined) patch.tags = args.tags;
  if (args.status !== undefined) {
    if (args.status !== "draft" && args.status !== "published") {
      return { error: "Invalid status. Must be one of: draft, published" };
    }
    patch.status = args.status;
  }
  if (Object.keys(patch).length === 0) {
    return { error: "At least one of parentId, tags, status is required" };
  }
  return client.updateWikiPageMetadata(habitatId, pageId, patch);
}

/**
 * @requires WikiClient
 */
export async function wikiAddLink(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  const pageId = args.pageId;
  const targetType = args.targetType;
  const targetId = args.targetId;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!pageId) return { error: "Missing required parameter: pageId" };
  if (!targetType) return { error: "Missing required parameter: targetType" };
  if (!targetId) return { error: "Missing required parameter: targetId" };
  if (!WIKI_LINK_TARGET_TYPES.includes(targetType)) {
    return {
      error: `Invalid targetType. Must be one of: ${WIKI_LINK_TARGET_TYPES.join(", ")}`,
    };
  }
  const input: { targetType: string; targetId: string; note?: string } = {
    targetType,
    targetId,
  };
  if (args.note !== undefined) input.note = args.note;
  return client.addWikiPageLink(habitatId, pageId, input);
}

/**
 * @requires WikiClient
 */
export async function wikiRemoveLink(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  const pageId = args.pageId;
  const linkId = args.linkId;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!pageId) return { error: "Missing required parameter: pageId" };
  if (!linkId) return { error: "Missing required parameter: linkId" };
  return client.removeWikiPageLink(habitatId, pageId, linkId);
}

/**
 * @requires WikiClient
 */
export async function wikiMarkNoUpdateNeeded(client: WikiClient, args: Record<string, any>) {
  const habitatId = args.habitatId;
  const from = args.from;
  const to = args.to;
  if (!habitatId) return { error: "Missing required parameter: habitatId" };
  if (!from) return { error: "Missing required parameter: from" };
  if (!to) return { error: "Missing required parameter: to" };
  const input: { from: string; to: string; reason?: string } = { from, to };
  if (args.reason !== undefined) input.reason = args.reason;
  return client.markNoUpdateNeeded(habitatId, input);
}

/**
 * @requires WikiClient
 *
 * Stub — backed by `wikiSchedulerService` (Phase 6, seed 10). The action is
 * registered so the tool surface is complete; agents see the action exists
 * and a clear "not yet implemented" error.
 */
export async function wikiTriggerRefresh(_client: WikiClient, _args: Record<string, any>) {
  return {
    error:
      "Wiki refresh is not yet implemented. It will be available after the wiki scheduler service ships in a future update.",
  };
}
