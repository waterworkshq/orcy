/**
 * Wiki destination adapter — promotes an accepted finding revision into at most
 * one Habitat Wiki draft page.
 *
 * Flow (all under the promotion service's ownership):
 * 1. Re-resolve citations and eligibility via the ticket-5 promotion service.
 * 2. Reserve the promotion idempotently (at-most-once per finding+destination).
 * 3. If the promotion already succeeded, return the existing page (replay).
 * 4. If the promotion previously failed, re-arm with a new lease for retry.
 * 5. Create a wiki draft page via `wikiService.createPage` (ALWAYS `status:"draft"`).
 * 6. Record the page ID on the promotion row (fenced, stays pending) so a retry
 *    after a crash can detect the already-created page.
 * 7. Add a reader-facing `extracted_finding` wiki link (removable, NOT authority).
 * 8. Terminalize the promotion as succeeded with the page ID + finding revision.
 *
 * The successful promotion row — NOT the wiki link — is the permanent derivation
 * record. Removing the link, editing the page, or publishing it does NOT remove
 * the promotion row (§18). A source-exclusion probe (§19) uses the promotion row
 * to reject any successfully-promoted page from future Wiki source batches.
 *
 * No automatic promotion or publication. No updating/merging existing pages.
 */
import { getDb } from "../db/index.js";
import {
  terminalizePromotionWithClient,
  recordPromotionTargetWithClient,
  reArmPromotionWithClient,
  reArmPendingPromotionLeaseWithClient,
  getFindingByIdWithClient,
  isWikiPageExcludedFromSources,
  getPoliciesByHabitatWithClient,
} from "../repositories/extraction/index.js";
import { checkPromotionEligibility, reservePromotion } from "./extractionPromotionService.js";
import { isLearningLoopGloballyEnabled } from "./extractionPolicyService.js";
import * as wikiService from "./wikiService.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { logger } from "../lib/logger.js";
import type { ExtractedFindingPromotionRow } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiPromotionResult {
  /** `"promoted"` = first success; `"already_promoted"` = replay of a prior success. */
  outcome: "promoted" | "already_promoted";
  promotion: ExtractedFindingPromotionRow;
  /** The wiki page ID created by this promotion (set on both outcomes). */
  pageId: string;
}

/** Outcome when the kill switch blocks a new promotion. */
export interface PromotionDisabledResult {
  outcome: "disabled";
  reason: "global_kill_switch" | "habitat_not_enrolled";
}

/** Pending leases younger than this are treated as live (no steal). */
const PROMOTION_LEASE_STALE_MS = 30_000;

function isPromotionLeaseStale(promotion: ExtractedFindingPromotionRow, now = Date.now()): boolean {
  const updated = Date.parse(promotion.updatedAt);
  if (Number.isNaN(updated)) return true;
  return now - updated >= PROMOTION_LEASE_STALE_MS;
}

// ---------------------------------------------------------------------------
// Page content derivation
// ---------------------------------------------------------------------------

/**
 * Derives bounded wiki page content from a finding's immutable subject, body,
 * and caveats. NEVER includes raw citation/source bodies — only a note that
 * the finding cites N sources, linkable through the `extracted_finding` link.
 */
function derivePageContent(finding: {
  subject: string;
  body: string;
  caveats: string[];
  confidence: number;
  sampleSize: number;
  findingType: string;
  revision: number;
}): string {
  const lines: string[] = [
    `# ${finding.subject}`,
    "",
    finding.body,
    "",
    "---",
    "",
    `**Type:** ${finding.findingType} | **Confidence:** ${(finding.confidence * 100).toFixed(0)}% | **Sample size:** ${finding.sampleSize} | **Revision:** ${finding.revision}`,
  ];

  if (finding.caveats.length > 0) {
    lines.push("", "**Caveats:**");
    for (const c of finding.caveats) {
      lines.push(`- ${c}`);
    }
  }

  lines.push("", "_This draft was promoted from an extraction finding. The finding citation link provides source lineage._");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Destination key
// ---------------------------------------------------------------------------

/**
 * Derive the stable destination key for a wiki-draft promotion in a habitat.
 * The key is scoped to the habitat so cross-habitat promotions are distinct.
 */
function wikiDestinationKey(habitatId: string): string {
  return `wiki:${habitatId}`;
}

// ---------------------------------------------------------------------------
// Promote
// ---------------------------------------------------------------------------

/**
 * Promote an accepted finding into at most one Habitat Wiki draft.
 *
 * @param habitatId  Habitat scope.
 * @param findingId  The finding to promote.
 * @param actorId    Human actor ID (promotion is human-only).
 * @throws `notFound` when the finding does not exist in this habitat.
 * @throws `badRequest` when the finding is not eligible (not accepted, stale,
 *   or has dangling/changed/unauthorized citations).
 * @throws `conflict` when another actor holds the promotion lease.
 */
export function promoteToWikiDraft(
  habitatId: string,
  findingId: string,
  actorId: string,
): WikiPromotionResult | PromotionDisabledResult {
  const db = getDb();

  // 0. Kill switch: enforce the global switch + per-habitat enrollment at the
  // promotion service boundary (not only in UI/route). Reads and privacy
  // withdrawal remain available when disabled (PATCH-CONSTRAINTS §21).
  if (!isLearningLoopGloballyEnabled()) {
    return { outcome: "disabled", reason: "global_kill_switch" };
  }
  const habitatPolicies = getPoliciesByHabitatWithClient(db, habitatId);
  const hasEnabledPolicy = habitatPolicies.some((p) => p.enabled);
  if (!hasEnabledPolicy) {
    return { outcome: "disabled", reason: "habitat_not_enrolled" };
  }

  const leaseOwner = `human:${actorId}`;
  const leaseGeneration = Date.now();
  const destinationKey = wikiDestinationKey(habitatId);

  // 1. Verify finding exists in this habitat (collapsed denial — no leak).
  const finding = getFindingByIdWithClient(db, findingId);
  if (!finding || finding.habitatId !== habitatId) {
    throw notFound("Finding not found");
  }

  // 2. Re-check eligibility (re-resolves all citations immediately before promotion).
  const eligibility = checkPromotionEligibility(habitatId, findingId);
  if (!eligibility.eligible) {
    throw badRequest("Finding is not eligible for promotion", {
      blockingCitations: eligibility.blockingCitations,
      caveats: eligibility.caveats,
    });
  }

  // 3. Reserve the promotion (idempotent on finding+destination).
  const reservation = reservePromotion({
    habitatId,
    findingId,
    destinationType: "wiki_draft",
    destinationKey,
    leaseOwner,
    leaseGeneration,
  });

  let promotion = reservation.promotion;

  // 4. Handle already_exists — at-most-once replay or re-arm for retry.
  if (reservation.outcome === "already_exists") {
    if (promotion.status === "succeeded") {
      // Replay: return the existing page.
      if (!promotion.targetId) {
        // Defensive: a succeeded promotion should always have a target.
        throw conflict("Promotion succeeded but has no page ID", { promotionId: promotion.id });
      }
      return { outcome: "already_promoted", promotion, pageId: promotion.targetId };
    }

    if (promotion.status === "failed") {
      // Retry: re-arm the failed promotion with a new lease.
      const reArmed = reArmPromotionWithClient(db, {
        promotionId: promotion.id,
        leaseOwner,
        leaseGeneration,
      });
      if (reArmed.outcome !== "re_armed") {
        throw conflict("Could not re-arm promotion for retry", {
          promotionId: promotion.id,
          state: reArmed.outcome,
        });
      }
      promotion = reArmed.promotion;
    } else if (promotion.status === "pending") {
      const sameOwner = promotion.leaseOwner === leaseOwner;
      const leaseStale = isPromotionLeaseStale(promotion);
      if (promotion.leaseOwner !== leaseOwner || promotion.leaseGeneration !== leaseGeneration) {
        if (!sameOwner && !leaseStale) {
          throw conflict("Promotion is already in progress", {
            promotionId: promotion.id,
          });
        }
        const reArmed = reArmPendingPromotionLeaseWithClient(db, {
          promotionId: promotion.id,
          leaseOwner,
          leaseGeneration,
          expectedLeaseOwner: promotion.leaseOwner,
          expectedLeaseGeneration: promotion.leaseGeneration,
        });
        if (reArmed.outcome !== "re_armed") {
          throw conflict("Promotion is already in progress", {
            promotionId: promotion.id,
            state: reArmed.outcome,
          });
        }
        promotion = reArmed.promotion;
      }
    }
  }

  // 5. Create the wiki page (ALWAYS draft) — crash-safe idempotent creation.
  // Use a deterministic promotion tag so a retry after a crash finds the
  // already-created page instead of creating a duplicate.
  const promotionTag = `extraction:promotion:${promotion.id}`;
  let pageId = promotion.targetId;
  if (!pageId) {
    // Check for an existing page from a prior crash (idempotent replay).
    const existing = wikiService.listPages(habitatId, { tag: promotionTag });
    if (existing.length > 0) {
      pageId = existing[0]!.id;
    } else {
      const page = wikiService.createPage(
        habitatId,
        {
          title: finding.subject,
          content: derivePageContent(finding),
          tags: ["extraction", finding.findingType, promotionTag],
          status: "draft",
        },
        actorId,
      );
      pageId = page.id;
    }

    // 6. Record the target on the promotion (fenced, stays pending).
    // The promotion row is the recovery authority — the promotion tag on the
    // page makes creation idempotent even when this recording is the failed
    // operation. A retry finds the page by tag before creating a new one.
    const recorded = recordPromotionTargetWithClient(db, {
      promotionId: promotion.id,
      leaseOwner,
      leaseGeneration,
      targetType: "wiki_page",
      targetId: pageId,
      targetVersion: "1",
    });
    if (recorded.outcome !== "recorded") {
      // Another owner raced us or the promotion was terminalized — fail honestly.
      // The created page is recoverable on retry via the promotion tag.
      logger.error(
        { promotionId: promotion.id, pageId, outcome: recorded.outcome },
        "Could not record promotion target after page creation",
      );
      throw conflict("Promotion target recording failed", {
        promotionId: promotion.id,
        outcome: recorded.outcome,
      });
    }
    promotion = recorded.promotion;
  }

  // 7. Add the reader-facing extracted_finding link (best-effort on retry).
  try {
    wikiService.addLink(pageId, {
      targetType: "extracted_finding",
      targetId: findingId,
      note: "Promoted from extraction finding",
    }, actorId);
  } catch (err) {
    // A duplicate link (409) is expected on retry — not an error.
    // Other errors are logged but do NOT block terminalization; the promotion
    // row is the authority, not the link.
    const isConflict = err instanceof Error && /already exists/i.test(err.message);
    if (!isConflict) {
      logger.warn(
        { err, pageId, findingId },
        "Wiki link creation failed after page creation (non-blocking)",
      );
    }
  }

  // 8. Terminalize as succeeded with the page ID + consumed finding revision.
  const result = terminalizePromotionWithClient(db, {
    promotionId: promotion.id,
    leaseOwner,
    leaseGeneration,
    status: "succeeded",
    targetType: "wiki_page",
    targetId: pageId,
    targetVersion: "1",
  });

  if (result.outcome !== "terminalized") {
    throw conflict("Promotion could not be terminalized", {
      promotionId: promotion.id,
      outcome: result.outcome,
    });
  }

  return { outcome: "promoted", promotion: result.promotion, pageId };
}

// ---------------------------------------------------------------------------
// Source-exclusion probe (§19 feedback-loop prevention)
// ---------------------------------------------------------------------------

/**
 * Check whether a wiki page is excluded from future source batches because it
 * was produced by a successful extraction promotion. This is the permanent
 * derivation probe: even after link removal, page edit, or publish, the
 * promotion row persists and excludes the page.
 */
export function isPageExcludedFromSources(pageId: string): boolean {
  return isWikiPageExcludedFromSources(getDb(), pageId);
}
