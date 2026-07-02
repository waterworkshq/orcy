import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { jiraAdapter } from "../../packages/api/src/services/integrations/jiraAdapter.js";

const integrationJiraPlugin: PluginModule = {
  manifest: {
    id: "integration-jira",
    version: "1.0.0",
    description: "Jira issue provider adapter (migrated from in-tree)",
    contributions: [
      {
        kind: "integrationProvider",
        scope: "system",
        provider: "jira",
        label: "Jira",
        authMethods: ["api_key", "oauth_code"],
        requires: [],
      },
    ],
  },
  providers: { jira: jiraAdapter },
};

export default integrationJiraPlugin;
