import type { PluginModule } from "../../packages/api/src/plugins/types.js";

/**
 * detector-regex-frustration reference plugin (Phase 9 of v0.22.0).
 *
 * Exercises the `signalDetector` contribution kind end-to-end: on a `pulseCreated`
 * event the loader invokes this handler with an envelope `PluginContext` carrying
 * the `pulseReader` capability; the handler reads the source pulse, regex-matches
 * frustration patterns against its subject+body, and returns one `DetectedSignalInput`
 * per match batch. The loader then writes the returned signals via
 * `pulseWriter.createDetectedSignal` (server-injected provenance per ADR-0013).
 *
 * Per ADRs 0013 (detected signal category) and 0015 (fire-and-forget trigger seam).
 */
const FRUSTRATION_PATTERNS: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(this\s+)?dependency\s+is\s+hell\b/i, category: "dependency_hell" },
  { pattern: /\bwhy\s+does\s+(this|it)\s+(always\s+)?break\b/i, category: "repeated_breakage" },
  { pattern: /\b(this\s+is\s+)?(so\s+)?frustrating\b/i, category: "frustration" },
  { pattern: /\b(stuck|blocked)\s+(again|still)\b/i, category: "stuck_loop" },
  { pattern: /\b(waste|wasting)\s+(of\s+)?time\b/i, category: "time_waste" },
  { pattern: /\bdoesn'?t\s+(make\s+)?sense\b/i, category: "confusion" },
  { pattern: /\b(terrible|awful|horrible)\s+(code|api|design)\b/i, category: "code_quality" },
];

const detectorPlugin: PluginModule = {
  manifest: {
    id: "detector-regex-frustration",
    version: "1.0.0",
    description:
      "Reference signal detector — watches pulse content for frustration patterns (regex-based)",
    contributions: [
      {
        kind: "signalDetector",
        scope: "habitat",
        detectorId: "regex-frustration",
        label: "Regex Frustration Detector",
        detects: "pulseCreated",
        rateLimitDefaults: { maxDetectionsPerMinute: 30, maxSignalsPerHour: 200 },
        requires: ["pulseReader", "pulseWriter"],
      },
    ],
  },
  detectors: {
    "regex-frustration": async (ctx, source) => {
      if (!ctx.pulseReader) return [];
      const pulse = await ctx.pulseReader.getPulse(source.sourceId);
      if (!pulse) return [];
      // Skip detected signals (recursion safety — the loader-side guard in
      // registerDetectorHooks already covers this, but defense-in-depth here).
      if (pulse.signalType === "detected") return [];

      const text = `${pulse.subject} ${pulse.body}`;
      const matches = FRUSTRATION_PATTERNS.filter((p) => p.pattern.test(text));
      if (matches.length === 0) return [];

      return [
        {
          signalType: "detected" as const,
          subject: `Frustration detected (${matches.map((m) => m.category).join(", ")})`,
          body: `Pattern matched in pulse: "${pulse.subject}"`,
          metadata: {
            categories: matches.map((m) => m.category),
            sourcePulseId: pulse.id,
          },
        },
      ];
    },
  },
};

export default detectorPlugin;
