/**
 * ADR-0039 T2 — Canonical contribution identity collision matrix.
 *
 * Pins the kind-safe canonical key contract:
 *   - Detector / Action / Channel keys are 3-tuples prefixed by contribution kind.
 *   - Lifecycle Interceptor keys are 5-tuples additionally keyed by phase and event.
 *   - Cross-kind same-ID contributions get distinct keys (the original v0.22-0.28 bug).
 *   - Same interceptorId across phase/event positions gets distinct keys.
 *   - The encoder is delimiter-safe: IDs containing `:` (or any other character)
 *     cannot collide. The serialized format is a JSON array of the tuple, so
 *     `JSON.stringify`'s escape rules handle every character unambiguously.
 *
 * These are pure unit tests against the encoder — no DB, no plugin loading.
 * The encoder is the single source of truth; no other site may construct keys
 * by concatenation (ADR-0039 § Canonical Contribution Identity Q9).
 */
import { describe, it, expect } from "vitest";
import { canonicalContributionKey } from "../plugins/contributionAdapters.js";

describe("ADR-0039 T2: canonicalContributionKey encoder", () => {
  describe("basic format (JSON array)", () => {
    it('Detector key is `["signalDetector",pluginId,detectorId]`', () => {
      expect(
        canonicalContributionKey({
          contributionKind: "signalDetector",
          pluginId: "my-plugin",
          contributionId: "det-1",
        }),
      ).toBe('["signalDetector","my-plugin","det-1"]');
    });

    it('Action key is `["automationAction",pluginId,actionId]`', () => {
      expect(
        canonicalContributionKey({
          contributionKind: "automationAction",
          pluginId: "auto-plug",
          contributionId: "send-email",
        }),
      ).toBe('["automationAction","auto-plug","send-email"]');
    });

    it('Channel key is `["notificationChannel",pluginId,channelId]`', () => {
      expect(
        canonicalContributionKey({
          contributionKind: "notificationChannel",
          pluginId: "chan-plug",
          contributionId: "teams",
        }),
      ).toBe('["notificationChannel","chan-plug","teams"]');
    });

    it("lifecycleInterceptor key includes phase and event suffix", () => {
      expect(
        canonicalContributionKey({
          contributionKind: "lifecycleInterceptor",
          pluginId: "lc-plug",
          contributionId: "approval-policy",
          phase: "pre",
          event: "taskApproved",
        }),
      ).toBe('["lifecycleInterceptor","lc-plug","approval-policy","pre","taskApproved"]');
    });
  });

  describe("cross-kind collision matrix (the headline T2 contract)", () => {
    /**
     * Same plugin + same kind-local ID, different contribution kinds. Under
     * the legacy `pluginId:contributionId` format all three collided — that
     * was the bug ADR-0039 Q9 fixes. Each must now produce a distinct key.
     */
    it("same plugin+id across Detector/Action/Channel produces three distinct keys", () => {
      const detector = canonicalContributionKey({
        contributionKind: "signalDetector",
        pluginId: "shared",
        contributionId: "x",
      });
      const action = canonicalContributionKey({
        contributionKind: "automationAction",
        pluginId: "shared",
        contributionId: "x",
      });
      const channel = canonicalContributionKey({
        contributionKind: "notificationChannel",
        pluginId: "shared",
        contributionId: "x",
      });
      expect(detector).toBe('["signalDetector","shared","x"]');
      expect(action).toBe('["automationAction","shared","x"]');
      expect(channel).toBe('["notificationChannel","shared","x"]');
      // Set size 3 ⇒ no collision.
      expect(new Set([detector, action, channel]).size).toBe(3);
    });

    /**
     * Same interceptorId across phase positions is a legitimate plugin pattern
     * (one policy engine vetoing both pre-create and pre-approve). Both must
     * get distinct keys so quarantining one does not block the other.
     */
    it("same interceptorId across phase produces distinct keys", () => {
      const preCreate = canonicalContributionKey({
        contributionKind: "lifecycleInterceptor",
        pluginId: "lc",
        contributionId: "policy",
        phase: "pre",
        event: "taskCreated",
      });
      const preApprove = canonicalContributionKey({
        contributionKind: "lifecycleInterceptor",
        pluginId: "lc",
        contributionId: "policy",
        phase: "pre",
        event: "taskApproved",
      });
      const postApprove = canonicalContributionKey({
        contributionKind: "lifecycleInterceptor",
        pluginId: "lc",
        contributionId: "policy",
        phase: "post",
        event: "taskApproved",
      });
      expect(preCreate).toBe('["lifecycleInterceptor","lc","policy","pre","taskCreated"]');
      expect(preApprove).toBe('["lifecycleInterceptor","lc","policy","pre","taskApproved"]');
      expect(postApprove).toBe('["lifecycleInterceptor","lc","policy","post","taskApproved"]');
      expect(new Set([preCreate, preApprove, postApprove]).size).toBe(3);
    });

    /**
     * Two plugins contributing detectors with the same kind-local ID under
     * the same plugin ID is impossible in practice (manifest IDs are unique),
     * but the encoder must still distinguish contributions by ID alone within
     * a kind.
     */
    it("two detectors under one plugin get distinct keys by contributionId", () => {
      const a = canonicalContributionKey({
        contributionKind: "signalDetector",
        pluginId: "p",
        contributionId: "d-a",
      });
      const b = canonicalContributionKey({
        contributionKind: "signalDetector",
        pluginId: "p",
        contributionId: "d-b",
      });
      expect(a).not.toBe(b);
    });
  });

  describe("delimiter safety (adversarial collision matrix)", () => {
    /**
     * The headline delimiter-safety proof: under any delimiter-based encoding,
     * `("a:b","c")` and `("a","b:c")` collide because their concatenation is
     * identical. JSON array encoding escapes each component independently, so
     * the serialized keys are distinct.
     *
     * This is the test the reviewer asked for explicitly. If this ever
     * regresses, the encoder is no longer delimiter-safe.
     */
    it("adversarial: ('a:b','c') and ('a','b:c') produce distinct keys", () => {
      const left = canonicalContributionKey({
        contributionKind: "signalDetector",
        pluginId: "a:b",
        contributionId: "c",
      });
      const right = canonicalContributionKey({
        contributionKind: "signalDetector",
        pluginId: "a",
        contributionId: "b:c",
      });
      expect(left).toBe('["signalDetector","a:b","c"]');
      expect(right).toBe('["signalDetector","a","b:c"]');
      expect(left).not.toBe(right);
    });

    it("adversarial: pluginId containing double-quote is JSON-escaped", () => {
      // A double-quote in a component would break naive concatenation. JSON's
      // escape rules handle it unambiguously.
      const key = canonicalContributionKey({
        contributionKind: "automationAction",
        pluginId: 'evil"plugin',
        contributionId: "x",
      });
      expect(key).toBe('["automationAction","evil\\"plugin","x"]');
      // Round-trip: parse and verify component recovers.
      const parsed = JSON.parse(key);
      expect(parsed[1]).toBe('evil"plugin');
    });

    it("adversarial: contributionId containing '[' and ']' is JSON-escaped", () => {
      // Brackets in a component would break naive array parsing. JSON handles them.
      const key = canonicalContributionKey({
        contributionKind: "notificationChannel",
        pluginId: "p",
        contributionId: "[evil]",
      });
      expect(key).toBe('["notificationChannel","p","[evil]"]');
      const parsed = JSON.parse(key);
      expect(parsed[2]).toBe("[evil]");
    });

    it("adversarial: empty-string components are preserved", () => {
      // An empty contributionId is unusual but legal at the type level. The
      // encoder must preserve it so two contributions differing only by
      // empty-vs-missing id do not collide.
      const empty = canonicalContributionKey({
        contributionKind: "signalDetector",
        pluginId: "p",
        contributionId: "",
      });
      const nonEmpty = canonicalContributionKey({
        contributionKind: "signalDetector",
        pluginId: "p",
        contributionId: "x",
      });
      expect(empty).toBe('["signalDetector","p",""]');
      expect(nonEmpty).toBe('["signalDetector","p","x"]');
      expect(empty).not.toBe(nonEmpty);
    });
  });

  describe("kind/phase/event validation", () => {
    it("rejects lifecycleInterceptor without phase/event", () => {
      expect(() =>
        canonicalContributionKey({
          contributionKind: "lifecycleInterceptor",
          pluginId: "p",
          contributionId: "x",
        }),
      ).toThrow(/lifecycleInterceptor requires phase and event/);
    });

    it("rejects phase/event on a non-interceptor kind", () => {
      expect(() =>
        canonicalContributionKey({
          contributionKind: "signalDetector",
          pluginId: "p",
          contributionId: "x",
          phase: "pre",
          event: "taskCreated",
        }),
      ).toThrow(/phase\/event are only valid for lifecycleInterceptor/);
    });
  });
});
