import type { KanbanPlugin } from '../../packages/api/src/plugins/types.js';
import { logger } from '../../packages/api/src/lib/logger.js';

const LABEL_RULES: Array<{ pattern: RegExp; labels: string[] }> = [
  { pattern: /\b(fix|bug|error|crash|broken)\b/i, labels: ['bug'] },
  { pattern: /\b(feat|feature|add|new)\b/i, labels: ['enhancement'] },
  { pattern: /\b(doc|docs|documentation|readme)\b/i, labels: ['documentation'] },
  { pattern: /\b(test|spec|testing)\b/i, labels: ['testing'] },
  { pattern: /\b(refactor|cleanup|clean up|restructure)\b/i, labels: ['refactor'] },
  { pattern: /\b(security|vuln|cve|xss|injection)\b/i, labels: ['security'] },
  { pattern: /\b(perf|performance|slow|optimize|speed)\b/i, labels: ['performance'] },
  { pattern: /\b(design|ui|ux|style|css|layout)\b/i, labels: ['design'] },
];

function extractLabels(title: string): string[] {
  const labels = new Set<string>();
  for (const rule of LABEL_RULES) {
    if (rule.pattern.test(title)) {
      for (const label of rule.labels) {
        labels.add(label);
      }
    }
  }
  return [...labels];
}

const autoLabelPlugin: KanbanPlugin = {
  name: 'scent-trail',
  version: '1.0.0',
  hooks: {
    onTaskCreated(task) {
      const suggestedLabels = extractLabels(task.title);
      if (suggestedLabels.length > 0) {
        logger.info({ taskId: task.id, suggestedLabels }, 'Auto-label plugin: suggested labels for task');
      }
    },
  },
};

export default autoLabelPlugin;
