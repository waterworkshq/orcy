import type { KanbanApiClient } from "../api.js";

/**
 * Learning Loop agent accepted-finding read handlers (Ticket 8).
 *
 * READ-ONLY contextual knowledge for a local agent acting through its supplied
 * active Task. Both actions require `habitatId` + active `taskId` and call the
 * ticket-5 actor-bound agent query via the REST surface — the repository
 * predicate is the SOLE authorization authority. No MCP-side recreation.
 *
 * Wire→backend param mapping is explicit at this seam (avoid the drift trap).
 * Handler validation is a backstop even though REST also validates via Zod —
 * MCP callers bypass REST if the dispatch handler is called directly.
 */

const HARD_LIMIT = 25;
const DEFAULT_LIMIT = 10;

function requireParam(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is required`);
  }
  return String(value);
}

function clampLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), HARD_LIMIT);
}

/**
 * @requires HabitatClient
 *
 * List accepted findings scoped to the calling agent's active Task.
 *
 * Explicit wire→backend mapping: the MCP tool exposes `habitatId`, `taskId`,
 * `findingType`, `maxAgeSeconds`, `limit`, `maxChars`. These map directly to
 * the REST query params of `GET /habitats/:habitatId/extraction/agent/findings`.
 * The REST handler passes them to the actor-bound repository query — the
 * predicate is the sole authorization authority.
 *
 * Limit is clamped to ≤25 as a backstop (REST also validates).
 */
export async function learningListAccepted(
  client: KanbanApiClient,
  args: Record<string, unknown>,
) {
  const habitatId = requireParam(args, "habitatId");
  const taskId = requireParam(args, "taskId");

  // Explicit wire→backend param mapping (no rest-spread — drift trap).
  const filters: {
    findingType?: string;
    maxAgeSeconds?: number;
    limit?: number;
    maxChars?: number;
  } = {};

  if (args.findingType !== undefined && args.findingType !== null && args.findingType !== "") {
    filters.findingType = String(args.findingType);
  }
  if (args.maxAgeSeconds !== undefined && args.maxAgeSeconds !== null) {
    const n = Number(args.maxAgeSeconds);
    if (Number.isFinite(n) && n > 0) {
      const MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
      filters.maxAgeSeconds = Math.min(Math.floor(n), MAX_AGE_SECONDS);
    }
  }
  // Clamp limit ≤25 — backstop even though REST validates.
  const limit = clampLimit(args.limit);
  filters.limit = limit;

  if (args.maxChars !== undefined && args.maxChars !== null) {
    const n = Number(args.maxChars);
    if (Number.isFinite(n) && n > 0) filters.maxChars = Math.floor(n);
  }

  const result = await client.listAcceptedFindings(habitatId, taskId, filters);
  return result;
}

/**
 * @requires HabitatClient
 *
 * Get a single accepted finding scoped to the calling agent's active Task.
 *
 * The REST route collapses not-found/forbidden/wrong-scope into a 404 —
 * denial does not leak existence. The handler re-throws the API error so the
 * dispatch wrapper formats it uniformly.
 */
export async function learningGetFinding(
  client: KanbanApiClient,
  args: Record<string, unknown>,
) {
  const habitatId = requireParam(args, "habitatId");
  const taskId = requireParam(args, "taskId");
  const findingId = requireParam(args, "findingId");

  // Explicit wire→backend param mapping.
  const result = await client.getAcceptedFinding(habitatId, findingId, taskId);
  return result;
}
