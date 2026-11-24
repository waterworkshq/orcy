/**
 * Request collection cap — the central pre-validation bound on request
 * collections. It does not depend on zod: it runs the same way on zod 3 and 4.
 *
 * Zod validates every element of an array and records one issue per failing
 * element, so the work a request triggers follows the request's shape, not
 * what the schema would ever accept. This root `preValidation` hook runs
 * after the body is parsed and before Fastify validates a route's declared
 * schema — itself before the policy-installed authentication guard and the
 * rate limiter, which are `preHandler` hooks — and before any handler-side
 * parsing. It answers `400 VALIDATION_ERROR` with a fixed-size body that
 * echoes nothing, so no element of an oversized collection is validated on
 * any route: declared or handler-parsed, present or future.
 *
 * What is bounded, at any nesting level of the parsed body or the query
 * string:
 *   - an array with more than the cap elements,
 *   - an object with more than the cap keys (a map costs one issue per value
 *     under a record schema),
 *   - nesting deeper than {@link MAX_REQUEST_DEPTH}.
 *
 * The walk is iterative and visits each container once, so its own cost stays
 * proportional to what the request body limit already admits. It bounds ONE
 * collection, never the sum of nested collections: the body limit is what
 * bounds the sum. Bodies that are not objects or arrays (text, raw bytes,
 * multipart streams) carry no collections and are skipped.
 *
 * The caps are constants on purpose, not configuration. The default is
 * evidence-derived: 256 is the largest upper bound any request schema in this
 * repository declares (the remote-access and shared-API route schemas), and
 * board import is the one legitimate payload that outgrows it.
 */
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { badRequest } from "../errors.js";

/** Largest collection (array elements or object keys) a request may carry at any nesting level. */
export const DEFAULT_REQUEST_COLLECTION_CAP = 256;

/**
 * Collection cap for the board import routes, which carry a whole exported
 * board (`POST /habitats/import`, `POST /habitats/:habitatId/import`).
 *
 * The only ceiling a legitimate import has is the 1 MiB request body limit.
 * The smallest record either exporter writes is a legacy webhook entry, 83
 * bytes on the wire with its separator, so no exported collection can hold
 * more than ⌊1,048,576 / 83⌋ = 12,633 records inside that limit. This is the
 * next power of two above it.
 */
export const IMPORT_REQUEST_COLLECTION_CAP = 16_384;

/** Deepest container level the walk descends to; a container below it is rejected. */
export const MAX_REQUEST_DEPTH = 64;

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Per-route collection cap in place of {@link DEFAULT_REQUEST_COLLECTION_CAP}
     * — for a route whose legitimate payload is a whole exported board. Any
     * other value than a positive integer falls back to the default.
     */
    requestCollectionCap?: number;
  }
}

export type OversizedCollection = "array" | "object" | "depth";

type Container = unknown[] | Record<string, unknown>;

/** Arrays and objects, except byte containers (Buffer and other typed arrays), which hold no collections. */
function isContainer(value: unknown): value is Container {
  return (
    Array.isArray(value) ||
    (typeof value === "object" && value !== null && !ArrayBuffer.isView(value))
  );
}

/**
 * First collection in `root` that exceeds `cap`, or `null` when none does.
 * Iterative with an explicit stack: deep input costs stack entries, not call
 * frames, and the depth bound stops the walk after {@link MAX_REQUEST_DEPTH}
 * container levels.
 */
export function findOversizedCollection(root: unknown, cap: number): OversizedCollection | null {
  if (!isContainer(root)) return null;

  const pending: [Container, number][] = [[root, 0]];
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [container, depth] = entry;
    const children: unknown[] = Array.isArray(container)
      ? container
      : Object.values(container);
    if (children.length > cap) return Array.isArray(container) ? "array" : "object";

    for (const child of children) {
      if (!isContainer(child)) continue;
      if (depth >= MAX_REQUEST_DEPTH) return "depth";
      pending.push([child, depth + 1]);
    }
  }
  return null;
}

function capFor(request: FastifyRequest): number {
  const configured = request.routeOptions.config?.requestCollectionCap;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_REQUEST_COLLECTION_CAP;
}

/**
 * The `preValidation` hook. Never names the offending field: a path is
 * request text, and the response stays one fixed size for every request.
 */
export function requestCollectionCap(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const cap = capFor(request);
  const oversize =
    findOversizedCollection(request.body, cap) ?? findOversizedCollection(request.query, cap);
  if (oversize === null) {
    done();
    return;
  }
  done(
    badRequest(
      oversize === "depth"
        ? `Request is nested more than ${MAX_REQUEST_DEPTH} levels deep`
        : `Request contains a collection with more than ${cap} items`,
    ),
  );
}
