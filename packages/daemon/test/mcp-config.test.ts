import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { generateMcpConfig, generateEnv, writeMcpConfig, MCP_SERVER_NAME } =
  await import("../src/mcp-config.js");

const agent = {
  id: "agent-01234567-89ab-cdef-0123-456789abcdef",
  name: "daemon-test-claude-code",
  type: "claude-code",
  apiKey: "test-api-key-0123456789abcdef0123456789abcdef",
};

const defaultOptions = {
  apiUrl: "http://localhost:3000",
  agent,
  workdir: "/tmp/workdir",
};

describe("mcp-config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), "orcy-mcp-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("generateMcpConfig", () => {
    it("generates correct MCP config structure", () => {
      const config = generateMcpConfig(defaultOptions);

      expect(config.mcpServers).toHaveProperty(MCP_SERVER_NAME);
      const server = config.mcpServers[MCP_SERVER_NAME];
      expect(server.command).toBe("node");
      expect(server.args).toEqual(expect.arrayContaining([expect.stringContaining("mcp")]));
      expect(server.env.ORCY_API_URL).toBe("http://localhost:3000");
      expect(server.env.ORCY_AGENT_ID).toBe(agent.id);
      expect(server.env.ORCY_API_KEY).toBe(agent.apiKey);
    });

    it("uses custom mcpServerPath when provided", () => {
      const config = generateMcpConfig({
        ...defaultOptions,
        mcpServerPath: "/custom/path/to/mcp.js",
      });

      expect(config.mcpServers[MCP_SERVER_NAME].args).toContain("/custom/path/to/mcp.js");
    });

    it("uses default mcpServerPath when not provided", () => {
      const config = generateMcpConfig(defaultOptions);
      expect(config.mcpServers[MCP_SERVER_NAME].args[0]).toContain("packages");
    });
  });

  describe("generateEnv", () => {
    it("generates environment variables with agent credentials", () => {
      const env = generateEnv(defaultOptions);

      expect(env.ORCY_API_URL).toBe("http://localhost:3000");
      expect(env.ORCY_AGENT_ID).toBe(agent.id);
      expect(env.ORCY_API_KEY).toBe(agent.apiKey);
      expect(env.ORCY_TASK_ID).toBe("");
      expect(env.ORCY_HABITAT_ID).toBe("");
    });
  });

  describe("writeMcpConfig", () => {
    it("writes .mcp.json to workdir", () => {
      const workdir = join(tempDir, "workspace");
      const configPath = writeMcpConfig({ ...defaultOptions, workdir });

      expect(configPath).toBe(join(workdir, ".mcp.json"));
      expect(fs.existsSync(configPath)).toBe(true);

      const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(written.mcpServers).toHaveProperty(MCP_SERVER_NAME);
    });

    it("creates workdir if it does not exist", () => {
      const workdir = join(tempDir, "new", "nested", "dir");
      writeMcpConfig({ ...defaultOptions, workdir });
      expect(fs.existsSync(workdir)).toBe(true);
    });

    it("uses targetDir override when provided", () => {
      const targetDir = join(tempDir, "other");
      const configPath = writeMcpConfig({ ...defaultOptions, workdir: "/tmp/x" }, targetDir);

      expect(configPath).toBe(join(targetDir, ".mcp.json"));
    });
  });
});
