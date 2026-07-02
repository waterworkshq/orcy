import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { githubAdapter } from "../../packages/api/src/services/integrations/githubAdapter.js";

const integrationGithubPlugin: PluginModule = {
  manifest: {
    id: "integration-github",
    version: "1.0.0",
    description: "GitHub issue provider adapter (migrated from in-tree)",
    contributions: [
      {
        kind: "integrationProvider",
        scope: "system",
        provider: "github",
        label: "GitHub",
        authMethods: ["pat", "oauth_device"],
        requires: [],
      },
    ],
  },
  providers: { github: githubAdapter },
};

export default integrationGithubPlugin;
