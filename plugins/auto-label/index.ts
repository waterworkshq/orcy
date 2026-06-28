import type { PluginModule } from "../../packages/api/src/plugins/types.js";

/**
 * auto-label reference plugin (ADR-0017 rewrite).
 *
 * Phase 3 stub replaced with a `lifecycleInterceptor` contribution (post phase,
 * `taskCreated`, requires `pulseWriter`). On task creation the handler regex-
 * matches the task title against a fixed rule set and emits a detected signal
 * carrying the suggested labels. The signal surfaces in the wiki "Detected
 * Signals" tab via the PulseWriter-detected path (ADR-0013).
 *
 * The handler is synchronous — post-phase handlers may be sync or async per
 * ADR-0014, and the dispatcher awaits either shape. Sync keeps the rule path
 * cheap: no event-loop hop for a pure-string classify.
 */
const LABEL_RULES: ReadonlyArray<{ pattern: RegExp; labels: string[] }> = [
  { pattern: /\b(fix|bug|error|crash|broken)\b/i, labels: ["bug"] },
  { pattern: /\b(feat|feature|add|new)\b/i, labels: ["enhancement"] },
  { pattern: /\b(doc|docs|documentation|readme)\b/i, labels: ["documentation"] },
  { pattern: /\b(test|spec|testing)\b/i, labels: ["testing"] },
  { pattern: /\b(refactor|cleanup|clean up|restructure)\b/i, labels: ["refactor"] },
  { pattern: /\b(security|vuln|cve|xss|injection)\b/i, labels: ["security"] },
  { pattern: /\b(perf|performance|slow|optimize|speed)\b/i, labels: ["performance"] },
  { pattern: /\b(design|ui|ux|style|css|layout)\b/i, labels: ["design"] },
];

function extractLabels(title: string): string[] {
  const labels = new Set<string>();
  for (const rule of LABEL_RULES) {
    if (rule.pattern.test(title)) {
      for (const label of rule.labels) labels.add(label);
    }
  }
  return [...labels];
}

const autoLabelPlugin: PluginModule = {
  manifest: {
    id: "auto-label",
    version: "1.0.0",
    description: "Auto-labels tasks by title analysis (reference lifecycle interceptor)",
    contributions: [
      {
        kind: "lifecycleInterceptor",
        scope: "habitat",
        interceptorId: "auto-label-suggest",
        phase: "post",
        event: "taskCreated",
        priority: 0,
        requires: ["pulseWriter"],
      },
    ],
  },
  interceptors: {
    "auto-label-suggest": (_ctx, transition) => {
      const title = transition.context.task?.title ?? "";
      const labels = extractLabels(title);
      if (labels.length === 0) return {};
      return {
        signals: [
          {
            signalType: "detected" as const,
            subject: "Auto-label: suggested labels",
            body: `Suggested: ${labels.join(", ")}`,
            metadata: { labels },
          },
        ],
      };
    },
  },
};

export default autoLabelPlugin;
