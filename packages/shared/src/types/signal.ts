import { z } from "zod";

/** Exhaustive readonly list of recognised pulse signal categories, including the v0.20 experience self-reporting type. */
export const SIGNAL_TYPES = [
  "finding",
  "blocker",
  "offer",
  "warning",
  "question",
  "answer",
  "directive",
  "context",
  "handoff",
  "experience",
] as const;

/** Union of the members of {@link SIGNAL_TYPES}, representing a categorised inter-agent signal. */
export type SignalType = (typeof SIGNAL_TYPES)[number];

/** Runtime list of structured Engineering Finding categories used for triage and wiki surfacing. */
export const FINDING_KINDS = [
  "pre_existing_bug",
  "scope_gap",
  "approach_deadend",
  "undocumented_convention",
  "deferred_fix_candidate",
  "schema_missing",
  "integration_broken",
  "other",
] as const;

/** Runtime list of structured Engineering Finding severity levels. */
export const FINDING_SEVERITIES = ["low", "medium", "high", "critical"] as const;

/** Runtime list of suggested routing buckets for structured Engineering Findings. */
export const SUGGESTED_BUCKETS = [
  "fix_now",
  "defer_to_patch",
  "defer_to_release",
  "document_as_known_limitation",
  "needs_investigation",
] as const;

/** Controlled category for a structured Engineering Finding. */
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Controlled severity level for a structured Engineering Finding. */
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Suggested routing bucket for a structured Engineering Finding. */
export type SuggestedBucket = (typeof SUGGESTED_BUCKETS)[number];

/** Structured metadata payload that opts an Engineering Finding into wiki surfacing and triage routing. */
export interface StructuredFindingMetadata {
  findingKind: FindingKind;
  severity: FindingSeverity;
  affectedFiles: string[];
  blocksCurrentWork: boolean;
  suggestedBucket?: SuggestedBucket;
  releaseImpact?: string[];
  identifiedDuring?: string;
}

const FINDING_REQUIRED_FIELDS = [
  "findingKind",
  "severity",
  "affectedFiles",
  "blocksCurrentWork",
] as const;

const findingKindSchema = z.enum(FINDING_KINDS);
const findingSeveritySchema = z.enum(FINDING_SEVERITIES);
const suggestedBucketSchema = z.enum(SUGGESTED_BUCKETS);
const stringArraySchema = z.array(z.string()).nonempty();

function addFieldIssue(ctx: z.RefinementCtx, path: string[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function validateField<T>(
  ctx: z.RefinementCtx,
  schema: z.ZodType<T>,
  path: string,
  value: unknown,
  message: string,
): void {
  const result = schema.safeParse(value);
  if (!result.success) addFieldIssue(ctx, [path], message);
}

/** Layered opt-in schema for Engineering Finding metadata while preserving free-form finding compatibility. */
export const findingMetadataSchema = z
  .object({})
  .passthrough()
  .superRefine((metadata, ctx) => {
    const hasStructuredRequiredField = FINDING_REQUIRED_FIELDS.some((field) => field in metadata);

    if (hasStructuredRequiredField) {
      const missingFields = FINDING_REQUIRED_FIELDS.filter((field) => !(field in metadata));
      if (missingFields.length > 0) {
        addFieldIssue(
          ctx,
          [],
          `Structured finding requires missing fields: ${missingFields.join(", ")}. Required fields: findingKind, severity, affectedFiles, blocksCurrentWork. Remove structured fields to post as a free-form finding.`,
        );
      }

      if ("findingKind" in metadata) {
        validateField(
          ctx,
          findingKindSchema,
          "findingKind",
          metadata.findingKind,
          `findingKind must be one of: ${FINDING_KINDS.join(", ")}`,
        );
      }
      if ("severity" in metadata) {
        validateField(
          ctx,
          findingSeveritySchema,
          "severity",
          metadata.severity,
          `severity must be one of: ${FINDING_SEVERITIES.join(", ")}`,
        );
      }
      if ("affectedFiles" in metadata) {
        validateField(
          ctx,
          stringArraySchema,
          "affectedFiles",
          metadata.affectedFiles,
          "affectedFiles must be a non-empty array of file paths",
        );
      }
      if ("blocksCurrentWork" in metadata && typeof metadata.blocksCurrentWork !== "boolean") {
        addFieldIssue(ctx, ["blocksCurrentWork"], "blocksCurrentWork must be a boolean");
      }
    }

    if ("suggestedBucket" in metadata) {
      validateField(
        ctx,
        suggestedBucketSchema,
        "suggestedBucket",
        metadata.suggestedBucket,
        `suggestedBucket must be one of: ${SUGGESTED_BUCKETS.join(", ")}`,
      );
    }
    if ("releaseImpact" in metadata) {
      validateField(
        ctx,
        z.array(z.string()),
        "releaseImpact",
        metadata.releaseImpact,
        "releaseImpact must be an array of strings",
      );
    }
    if ("identifiedDuring" in metadata && typeof metadata.identifiedDuring !== "string") {
      addFieldIssue(ctx, ["identifiedDuring"], "identifiedDuring must be a string");
    }
  });
