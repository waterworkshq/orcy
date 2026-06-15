import { createServer } from "http";
import { execSync } from "child_process";
import { api } from "../client.js";
import { withErrorHandling } from "../error-handler.js";

const OAUTH_CALLBACK_PORT = 17530;

function startCallbackServer(): Promise<{
  port: number;
  callback: Promise<{ code: string; state: string }>;
}> {
  let resolveCallback: (callback: { code: string; state: string }) => void;
  let rejectCallback: (err: Error) => void;

  const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const codeParam = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");

    if (errorParam) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Authorization failed</h1><p>You can close this tab.</p></body></html>",
      );
      setImmediate(() => {
        rejectCallback!(new Error(`OAuth error: ${errorParam}`));
        server.close();
      });
      return;
    }

    if (codeParam && stateParam) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Authorization successful</h1><p>You can close this tab and return to Orcy.</p></body></html>",
      );
      setImmediate(() => {
        resolveCallback!({ code: codeParam, state: stateParam });
        server.close();
      });
      return;
    }

    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<html><body><h1>Missing authorization code or state</h1></body></html>");
  });

  return new Promise((resolve, reject) => {
    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
      const timeout = setTimeout(
        () => {
          rejectCallback!(new Error("OAuth callback timed out after 5 minutes"));
          server.close();
        },
        5 * 60 * 1000,
      );

      callback.catch(() => {}).finally(() => clearTimeout(timeout));

      resolve({ port: OAUTH_CALLBACK_PORT, callback });
    });

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${OAUTH_CALLBACK_PORT} is already in use. Close the process using it and try again.`,
          ),
        );
      } else {
        reject(err);
      }
      server.close();
    });
  });
}

function openBrowser(url: string): void {
  try {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execSync(`${cmd} "${url}"`, { stdio: "ignore" });
  } catch {
    console.log(`Could not open browser. Open this URL manually:\n${url}`);
  }
}

function printIntegrationGuide(provider?: string): void {
  const selected = provider?.toLowerCase();
  if (selected && !["jira", "linear", "all"].includes(selected)) {
    throw new Error(`Provider '${provider}' is not supported. Use 'jira', 'linear', or 'all'.`);
  }

  if (!selected || selected === "all" || selected === "linear") {
    console.log("Linear setup");
    console.log("  Recommended: OAuth PKCE via `orcy integrations connect <habitat-id> linear`");
    console.log("  Dashboard callback URL: http://127.0.0.1:17530/callback");
    console.log("  Secret handling: no Linear client secret is required for the PKCE flow.");
    console.log(
      "  Optional override: ORCY_LINEAR_OAUTH_CLIENT_ID if you use your own Linear OAuth app.",
    );
    console.log("");
  }

  if (!selected || selected === "all" || selected === "jira") {
    console.log("Jira Cloud setup");
    console.log(
      "  Recommended: API token setup in the Orcy UI: Habitat Settings -> Integrations -> Jira Cloud.",
    );
    console.log(
      "  You need: Atlassian email, Atlassian API token, Jira site URL, and project key.",
    );
    console.log("  Create token: https://id.atlassian.com/manage-profile/security/api-tokens");
    console.log("  Site URL example: https://your-site.atlassian.net");
    console.log("  Project key example: ENG from issue ENG-123");
    console.log(
      "  Advanced OAuth: `orcy integrations connect <habitat-id> jira` only works when the API server has ORCY_JIRA_OAUTH_CLIENT_ID and ORCY_JIRA_OAUTH_CLIENT_SECRET configured.",
    );
    console.log(
      "  Secret handling: never commit Jira OAuth client secrets; self-hosted users must provide their own env vars.",
    );
    console.log("");
  }
}

async function runOAuthConnect(habitatId: string, provider: "jira" | "linear"): Promise<void> {
  const startPath = `/api/habitats/${habitatId}/integrations/${provider}/oauth/start`;

  if (provider === "jira") {
    console.log(
      "Jira OAuth is an advanced self-hosted path. For most local installs, use Jira API token setup in the UI.",
    );
    console.log(
      "Required for OAuth: ORCY_JIRA_OAUTH_CLIENT_ID and ORCY_JIRA_OAUTH_CLIENT_SECRET on the API server.",
    );
  }

  console.log(`Starting ${provider} OAuth flow...`);

  const { port, callback } = await startCallbackServer();

  const startResult = await api.post<{ authUrl: string; state: string; redirectPort: number }>(
    startPath,
    { redirectPort: port },
  );

  console.log(`Opening browser for ${provider} authorization...`);
  console.log(`Callback server listening on http://127.0.0.1:${port}`);
  openBrowser(startResult.authUrl);

  console.log("Waiting for authorization...");
  const { code: authCode, state } = await callback;
  if (state !== startResult.state) {
    throw new Error("OAuth callback state did not match. Refusing to complete authorization.");
  }

  console.log("Authorization code received, completing connection...");
  const completePath = `/api/habitats/${habitatId}/integrations/${provider}/oauth/complete`;
  const result = await api.post<{ integration: Record<string, unknown> }>(completePath, {
    code: authCode,
    state: startResult.state,
    redirectPort: port,
  });

  console.log(`${provider} connection created successfully!`);
  console.log(`  Name: ${result.integration.name ?? "N/A"}`);
  console.log(`  ID:   ${result.integration.id ?? "N/A"}`);
}

/** Registers the `orcy integrations` subcommands (guide, connect, sync, intake) on the given {@link Command}. */
export function registerIntegrationCommands(program: any) {
  const integration = program
    .command("integrations")
    .description("External integration operations");

  integration
    .command("guide")
    .description("Show setup guidance for Jira and Linear integrations")
    .argument("[provider]", "Provider: jira, linear, or all")
    .action(
      withErrorHandling(async (provider?: string) => {
        printIntegrationGuide(provider);
      }),
    );

  integration
    .command("connect")
    .description("Connect an external provider via OAuth (opens browser)")
    .argument("<habitat-id>", "Habitat ID to connect to")
    .argument("<provider>", "Provider: jira, linear")
    .action(
      withErrorHandling(async (habitatId: string, provider: string) => {
        if (provider !== "jira" && provider !== "linear") {
          throw new Error(
            `Provider '${provider}' is not supported for OAuth. Use 'jira' or 'linear'.`,
          );
        }
        await runOAuthConnect(habitatId, provider);
      }),
    );

  integration
    .command("sync")
    .description("Trigger manual sync for a connection")
    .argument("<connection-id>", "Connection ID to sync")
    .action(
      withErrorHandling(async (connectionId: string) => {
        const result = await api.post<Record<string, unknown>>(
          `/api/integrations/${connectionId}/sync`,
        );
        console.log(JSON.stringify(result, null, 2));
      }),
    );

  integration
    .command("list")
    .description("List integrations for a habitat")
    .argument("<habitat-id>", "Habitat ID")
    .action(
      withErrorHandling(async (habitatId: string) => {
        const result = await api.get<Record<string, unknown>>(
          `/api/habitats/${habitatId}/integrations`,
        );
        console.log(JSON.stringify(result, null, 2));
      }),
    );

  integration
    .command("disconnect")
    .description("Disconnect (disable) an integration")
    .argument("<connection-id>", "Connection ID to disconnect")
    .action(
      withErrorHandling(async (connectionId: string) => {
        await api.delete(`/api/integrations/${connectionId}`);
        console.log("Connection disabled.");
      }),
    );

  integration
    .command("intake")
    .description("List intake candidates for a habitat")
    .argument("<habitat-id>", "Habitat ID")
    .option(
      "--status <status>",
      "Filter by review status: new, needs_clarification, ready, promoted, ignored",
    )
    .option("--provider <provider>", "Filter by provider: jira, linear, github")
    .action(
      withErrorHandling(
        async (habitatId: string, options: { status?: string; provider?: string }) => {
          const params = new URLSearchParams();
          if (options.status) params.set("reviewStatus", options.status);
          if (options.provider) params.set("provider", options.provider);
          const qs = params.toString();
          const result = await api.get<Record<string, unknown>>(
            `/api/habitats/${habitatId}/intake-candidates${qs ? `?${qs}` : ""}`,
          );
          console.log(JSON.stringify(result, null, 2));
        },
      ),
    );

  integration
    .command("promote")
    .description("Promote an intake candidate to a mission")
    .argument("<candidate-id>", "Candidate ID to promote")
    .action(
      withErrorHandling(async (candidateId: string) => {
        const result = await api.post<Record<string, unknown>>(
          `/api/intake-candidates/${candidateId}/promote`,
        );
        console.log(`Promoted to mission: ${(result as any).mission?.title ?? candidateId}`);
      }),
    );

  integration
    .command("ignore")
    .description("Ignore an intake candidate")
    .argument("<candidate-id>", "Candidate ID to ignore")
    .action(
      withErrorHandling(async (candidateId: string) => {
        await api.post<Record<string, unknown>>(`/api/intake-candidates/${candidateId}/ignore`);
        console.log("Candidate ignored.");
      }),
    );
}
