/**
 * CS-56 T2 — Recursive, depth-bounded discriminated schema for
 * {@link AutomationCondition}.
 *
 * This schema is the single source of truth for the shape of every
 * authored condition tree in the API surface. It is applied at:
 *   - rule creation  (POST /habitats/:habitatId/automation-rules)
 *   - rule update    (PUT /automation-rules/:ruleId)
 *   - rule enable    (POST /automation-rules/:ruleId/enable)
 *   - simulation     (POST /automation-rules/:ruleId/simulate)
 *
 * It is ALSO consumed by `validatePersistedCondition` (below) so already-
 * persisted rules whose `condition` JSON pre-dates the schema can be re-
 * validated before evaluation. Invalid persisted conditions are NOT silently
 * rewritten to `{type:"always"}` — they remain readable and are reported as
 * a structural problem so the canonical lifecycle (T3) can fail closed.
 *
 * Why this lives in @orcy/api (not @orcy/shared):
 *   - It depends on Zod as a runtime dependency. `@orcy/shared` ships pure
 *     type/value utilities with no runtime deps; adding Zod there would
 *     propagate it into every dependent workspace package.
 *   - The validator is consumed by route handlers and the runtime
 *     pre-evaluation check, both of which live in @orcy/api.
 *   - The discriminator/operator union TYPES still live in @orcy/shared
 *     (see `AutomationConditionOperator` and `AutomationConditionComparison`)
 *     so the in-memory shape is consistent across the boundary.
 *
 * Design notes (CS-56 T2 scope):
 *   - Depth is bounded by the evaluator's MAX_CONDITION_DEPTH (5) — see
 *     `packages/api/src/services/automationEvaluator.ts`.
 *   - `and`/`or` allow zero children to preserve current empty-evaluation
 *     semantics (empty `and` matches vacuously; empty `or` does not).
 *   - `not` requires exactly one `child` — the existing evaluator already
 *     treats a missing child as vacuously-true; the schema forces the
 *     explicit form so empty-`not` is no longer authorable.
 *   - `field` roots are restricted to the documented evaluator roots
 *     (task/mission/habitat/agent/sprint/raw); unknown roots evaluate to
 *     `undefined` in the live resolver — the schema rejects them outright
 *     so authors cannot bake a guaranteed-false tree.
 *   - Passthrough extensibility is intentionally limited to plugin `params`
 *     — the rest of the tree is closed by the discriminated union.
 */
import { z } from "zod";
import { MAX_CONDITION_DEPTH } from "../services/automationEvaluator.js";
import type {
  AutomationCondition,
  AutomationConditionComparison,
  AutomationConditionOperator,
} from "@orcy/shared";

/** Operators accepted by the field-comparison predicate. */
const FIELD_COMPARISON_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "greater_than",
  "less_than",
  "in",
  "not_in",
  "exists",
  "not_exists",
] as const satisfies readonly AutomationConditionComparison[];

/** Boolean combinators (preserve the existing `and`/`or` shapes). */
const BOOLEAN_OPERATORS = ["and", "or"] as const satisfies readonly AutomationConditionOperator[];

/** Roots the `field` predicate may legally reference. Mirrors `resolveFieldPath` in the evaluator. */
const FIELD_ROOTS = ["task", "mission", "habitat", "agent", "sprint", "raw"] as const;

/** Build the discriminated-union schema once (lazily so recursion resolves). */
function makeDiscriminatedUnion(): z.ZodType<AutomationCondition> {
  type Schema = z.ZodType<AutomationCondition>;
  const conditionSchema: Schema = z.lazy((): Schema => {
    const booleanLeaf = (op: (typeof BOOLEAN_OPERATORS)[number]): Schema =>
      z.object({
        type: z.literal(op),
        // Preserve current empty-evaluation semantics: zero children are
        // legal; the evaluator documents empty-AND = vacuously-true,
        // empty-OR = vacuously-false. The schema therefore enforces
        // structure, not non-emptiness.
        children: z.array(conditionSchema),
      }) as unknown as Schema;

    // Use `z.union` rather than `z.discriminatedUnion` because the
    // recursive `and`/`or`/`not` branches return `ZodType<AutomationCondition>`
    // (via `as unknown as Schema`) rather than `ZodObject`, which the
    // discriminated-union constructor refuses. Zod's union still does
    // discriminator-style optimization for `object.type` first, so the
    // runtime cost is identical to the discriminated form for the
    // documented types.
    const options = [
      z.object({ type: z.literal("always") }),
      booleanLeaf("and"),
      booleanLeaf("or"),
      z.object({
        type: z.literal("not"),
        // The existing evaluator treats a missing `not.child` as vacuously
        // true. The schema forces an explicit child so empty-`not` is no
        // longer authorable; persisted trees with this defect remain
        // readable for runtime fail-closed handling.
        child: conditionSchema,
      }),
      z.object({
        type: z.literal("field"),
        field: z
          .string()
          .min(1)
          .refine(
            (field) => {
              const root = field.split(".")[0];
              return (FIELD_ROOTS as readonly string[]).includes(root);
            },
            {
              message: `field root must be one of ${FIELD_ROOTS.join(", ")}`,
            },
          ),
        operator: z.enum(FIELD_COMPARISON_OPERATORS),
        value: z.unknown(),
      }),
      z.object({
        type: z.literal("priority_above"),
        threshold: z.enum(["low", "medium", "high", "critical"]),
      }),
      z.object({
        type: z.literal("priority_below"),
        threshold: z.enum(["low", "medium", "high", "critical"]),
      }),
      z.object({
        type: z.literal("status_in"),
        statuses: z.array(z.string().min(1)).min(1),
      }),
      z.object({
        type: z.literal("assigned_to"),
        recipientType: z.string().min(1),
        recipientId: z.string().min(1),
      }),
      z.object({ type: z.literal("unassigned") }),
      z.object({
        type: z.literal("overdue_by"),
        minutes: z.number().finite().nonnegative(),
      }),
      z.object({
        type: z.literal("label_contains"),
        label: z.string().min(1),
      }),
      z.object({
        type: z.literal("domain_is"),
        domain: z.string().min(1),
      }),
      z.object({
        type: z.literal("plugin"),
        conditionId: z.string().min(1),
        // Plugin params are the only intentional passthrough in the tree
        // (ADR-0022). Authors may include plugin-specific data; everything
        // else above is closed by the discriminated union.
        params: z.record(z.unknown()).optional(),
      }),
    ] as const;
    return z.union(options as unknown as readonly [Schema, Schema, ...Schema[]]) as unknown as Schema;
  });
  return conditionSchema;
}

/** Compute the maximum nesting depth of a (possibly malformed) condition tree. */
function depthOf(node: unknown): number {
  if (!node || typeof node !== "object" || !("type" in node)) return 0;
  const t = (node as Record<string, unknown>).type;
  if (t === "and" || t === "or") {
    const children = Array.isArray((node as Record<string, unknown>).children)
      ? ((node as Record<string, unknown>).children as unknown[])
      : [];
    if (children.length === 0) return 1;
    return 1 + Math.max(...children.map(depthOf));
  }
  if (t === "not") {
    const child = (node as Record<string, unknown>).child;
    return 1 + depthOf(child);
  }
  return 1;
}

/** Compose the discriminated-union schema with depth-bounded refinement. */
function makeBoundedSchema(): z.ZodType<AutomationCondition> {
  const inner = makeDiscriminatedUnion();
  return z.unknown().superRefine((value, ctx) => {
    const depth = depthOf(value);
    if (depth > MAX_CONDITION_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `condition nesting depth ${depth} exceeds MAX_CONDITION_DEPTH=${MAX_CONDITION_DEPTH}`,
        path: [],
      });
      return;
    }
    const result = (inner as z.ZodType<AutomationCondition>).safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          // The depth pre-check above may surface path collisions; fall
          // back to the empty path so Zod's flattening reports at root.
          path: issue.path,
        });
      }
    }
  }) as unknown as z.ZodType<AutomationCondition>;
}

/**
 * The recursive depth-bounded discriminated schema for authored conditions.
 *
 * Use this at route boundaries (create / update / enable / simulate) and
 * via {@link validatePersistedCondition} at the runtime-evaluation seam.
 */
export const automationConditionSchema: z.ZodType<AutomationCondition> = makeBoundedSchema();

/**
 * Outcome of validating a persisted condition tree.
 *
 * `valid` is `true` when the tree matches the schema AND its nesting does
 * not exceed {@link MAX_CONDITION_DEPTH}. `issues` carries the schema-level
 * error messages (empty when `valid` is true); `diagnostic` is a bounded
 * summary safe for persistence (no full thrown objects, no secrets).
 */
export interface ConditionValidationOutcome {
  valid: boolean;
  issues: string[];
  diagnostic: string | null;
}

/** Maximum number of issues kept in the persisted diagnostic. */
const MAX_DIAGNOSTIC_ISSUES = 5;
/** Maximum total length of the diagnostic string (defense against runaway persisted blobs). */
const MAX_DIAGNOSTIC_LENGTH = 512;

/** Build a bounded diagnostic string from a list of schema issues. */
function boundedDiagnostic(issues: string[]): string {
  const trimmed = issues.slice(0, MAX_DIAGNOSTIC_ISSUES).join("; ");
  return trimmed.length > MAX_DIAGNOSTIC_LENGTH
    ? trimmed.slice(0, MAX_DIAGNOSTIC_LENGTH - 1) + "…"
    : trimmed;
}

/**
 * Runtime validator for already-persisted condition trees (i.e., rows
 * that pre-date the schema or were authored outside the route surface).
 *
 * This validator MUST NOT silently replace an invalid tree with
 * `{type:"always"}`. The canonical lifecycle (T3) reads `valid: false` as
 * the trigger to fail the attempt closed; the diagnostic string is what
 * gets persisted for operator repair.
 */
export function validatePersistedCondition(value: unknown): ConditionValidationOutcome {
  const parsed = automationConditionSchema.safeParse(value);
  if (parsed.success) {
    return { valid: true, issues: [], diagnostic: null };
  }
  const issues = parsed.error.issues.map((i) => {
    const path = i.path.length ? i.path.join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  return {
    valid: false,
    issues,
    diagnostic: boundedDiagnostic(issues),
  };
}

/**
 * Strict schema-application helper for route handlers. Returns either the
 * validated `AutomationCondition` (when `value` is provided) or `undefined`
 * when callers explicitly want to omit the field (e.g., PUT that doesn't
 * touch the condition). Throws `ZodError` when `value` is provided but invalid.
 */
export function parseAuthoredCondition(value: unknown): AutomationCondition | undefined {
  if (value === undefined) return undefined;
  return automationConditionSchema.parse(value);
}