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
 * proportional to the size of what it reads: the request body limit for the
 * body, the URL length limit for the query string. It bounds ONE collection,
 * never the sum of nested collections: the body limit is what bounds the sum.
 * Bodies that are not objects or arrays (text, raw bytes, multipart streams)
 * carry no collections and are skipped.
 *
 * The caps are constants on purpose, not configuration; each one's
 * documentation says what it is derived from. A route whose legitimate
 * payload outgrows the default raises it through `config.requestCollectionCap`.
 */
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import { badRequest } from "../errors.js";

/**
 * Largest collection (array elements or object keys) a request may carry at
 * any nesting level.
 *
 * Evidence, not a tuning knob. It has to stay above the collections that grow
 * with the size of a board or a repository and have no route of their own —
 * a board's column order, a mission's dependency list, a daemon's agent
 * statuses. Every size the repository itself defines is far below it: the
 * largest upper bound a request array schema declares is 100 (batch task ids
 * and the remote-access routes), and 200 is the largest page the task,
 * mission, and event lists serve. 2,048 is the nearest power of two that
 * keeps an order of magnitude over both.
 *
 * What the cap still costs, in elements: one flat collection can hold 2,048
 * elements before it is rejected. The densest array the 1 MiB request body
 * limit admits is 524,288 two-byte elements, so the cap cuts that by 256.
 */
export const DEFAULT_REQUEST_COLLECTION_CAP = 2_048;

/**
 * Collection cap for the routes that carry a whole board: the import routes
 * (`POST /habitats/import`, `POST /habitats/:habitatId/import`) and the
 * workflow routes (`POST /missions/:id/workflow`, `PATCH /workflows/:id`).
 *
 * Derived from what the 1 MiB request body limit holds, record by record.
 * The smallest record either exporter writes is a legacy webhook entry: 78
 * bytes on the wire with its separator (`"slack"` is its shortest format, with
 * empty name/url strings), so one exported collection holds at most
 * ⌊1,048,576 / 78⌋ = 13,443 records. The smallest gate record the workflow
 * schema accepts is 69 bytes (`on_fail` is its shortest gate type), so one
 * workflow holds at most 15,196. 16,384 is the next power of two above both.
 *
 * That is a ceiling on records, not on every array these schemas accept. The
 * plain string arrays an export carries — a mission's labels and dependency
 * titles, a task's or template's capabilities — are authored per entity and
 * have no schema-level bound, so a document with more than 16,384 entries in
 * one of them is rejected although it fits the body limit. The same holds
 * for a workflow's variable records (28 bytes) and for a document written by
 * another tool with smaller records than the exporters write.
 */
export const BOARD_REQUEST_COLLECTION_CAP = 16_384;

/**
 * Collection cap for the code-evidence link routes (`POST /tasks/:id/code-evidence`,
 * `POST /missions/:id/code-evidence`), which carry a pull request's files
 * and commits.
 *
 * The smallest changed-file record the schema accepts is 33 bytes on the
 * wire (`{"path":"","changeType":"added"}` and its separator), so the 1 MiB
 * body limit holds at most ⌊1,048,576 / 33⌋ = 31,775 of them. 32,768 is the
 * next power of two, so no changed-file list the body admits is rejected.
 *
 * Commit records are not covered that far. The smallest the schema accepts
 * is 11 bytes (`{"sha":""}` and its separator), so a body can hold up to
 * 95,325 of them, and a commit list with more than 32,768 such records is
 * rejected on purpose: schema validation on these routes runs before
 * authentication, and a cap high enough to admit that minimum would give up
 * most of the bound.
 */
export const CODE_EVIDENCE_REQUEST_COLLECTION_CAP = 32_768;

/** Deepest container level the walk descends to; a container below it is rejected. */
export const MAX_REQUEST_DEPTH = 64;

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Per-route collection cap in place of {@link DEFAULT_REQUEST_COLLECTION_CAP}
     * — for a route whose legitimate payload outgrows the default. Any value
     * other than a positive integer falls back to the default.
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
