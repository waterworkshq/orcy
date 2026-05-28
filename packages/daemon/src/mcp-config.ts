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

export function generateEnv(options: McpConfigOptions): Record<string, string> {
  return {
    ORCY_API_URL: options.apiUrl,
    ORCY_AGENT_ID: options.agent.id,
    ORCY_API_KEY: options.agent.apiKey,
    ORCY_TASK_ID: "",
    ORCY_HABITAT_ID: "",
  };
}

export function writeMcpConfig(options: McpConfigOptions, targetDir?: string): string {
  const dir = targetDir ?? options.workdir;
  const config = generateMcpConfig(options);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const configPath = join(dir, ".mcp.json");
  const safeConfig = JSON.parse(JSON.stringify(config));
  for (const server of Object.values(safeConfig.mcpServers) as Array<{
    env: Record<string, string>;
  }>) {
    server.env = redactObject(server.env) as Record<string, string>;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
}

export { MCP_SERVER_NAME };
