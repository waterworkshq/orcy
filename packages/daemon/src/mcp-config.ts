import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { McpConfig, RegisteredAgent } from "./types.js";
import { redactObject } from "./redact.js";

const MCP_SERVER_NAME = "orcy";

interface McpConfigOptions {
  apiUrl: string;
  agent: RegisteredAgent;
  workdir: string;
  mcpServerPath?: string;
}

/** Builds an MCP server config object pointing at the orcy MCP server with agent-scoped env vars. */
export function generateMcpConfig(options: McpConfigOptions): McpConfig {
  const serverPath =
    options.mcpServerPath ?? join(process.cwd(), "packages", "mcp", "dist", "index.js");

  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        args: [serverPath],
        env: {
          ORCY_API_URL: options.apiUrl,
          ORCY_AGENT_ID: options.agent.id,
          ORCY_API_KEY: options.agent.apiKey,
        },
      },
    },
  };
}

/** Builds the `ORCY_*` env vars an agent process needs to talk to the daemon API. */
export function generateEnv(options: McpConfigOptions): Record<string, string> {
  return {
    ORCY_API_URL: options.apiUrl,
    ORCY_AGENT_ID: options.agent.id,
    ORCY_API_KEY: options.agent.apiKey,
    ORCY_TASK_ID: "",
    ORCY_HABITAT_ID: "",
  };
}

/** Writes a redacted {@link generateMcpConfig} payload to `<dir>/.mcp.json`, creating `<dir>` if missing. */
export function writeMcpConfig(options: McpConfigOptions, targetDir?: string): string {
  const dir = targetDir ?? options.workdir;
  const config = generateMcpConfig(options);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const configPath = join(dir, ".mcp.json");
  const safeConfig = structuredClone(config);
  for (const server of Object.values(safeConfig.mcpServers) as Array<{
    env: Record<string, string>;
  }>) {
    server.env = redactObject(server.env) as Record<string, string>;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}

/** Canonical MCP server name used as the key inside `.mcp.json` `mcpServers`. */
export { MCP_SERVER_NAME };
