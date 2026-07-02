import type { PluginModule } from "../../packages/api/src/plugins/types.js";
import { linearAdapter } from "../../packages/api/src/services/integrations/linearAdapter.js";

const integrationLinearPlugin: PluginModule = {
  manifest: {
    id: "integration-linear",
    version: "1.0.0",
    description: "Linear issue provider adapter (migrated from in-tree)",
    contributions: [
      {
        kind: "integrationProvider",
        scope: "system",
        provider: "linear",
        label: "Linear",
        authMethods: ["api_key", "oauth_pkce"],
        requires: [],
      },
    ],
  },
  providers: { linear: linearAdapter },
};

export default integrationLinearPlugin;
