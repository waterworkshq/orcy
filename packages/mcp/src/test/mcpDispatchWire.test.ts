/** Actual source entrypoint over stdio; only the outbound HTTP API is a fake. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
let api: Server;
let client: Client;
const requests: string[] = [];

beforeAll(async () => {
  api = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ habitats: [{ id: "wire-habitat", name: "Wire", description: "Dispatch control" }] }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test listener");
  client = new Client({ name: "dispatch-boundary-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", require.resolve("tsx"), fileURLToPath(new URL("../index.ts", import.meta.url))],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ORCY_API_URL: `http://127.0.0.1:${address.port}`,
    },
    stderr: "pipe",
  }));
});

afterAll(async () => {
  await client?.close();
  if (api) await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
});

describe("MCP registered tool boundary over stdio", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "unknown_tool"])(
    "rejects unregistered tool %s with the ordinary unknown-tool result",
    async (name) => {
      const before = requests.length;
      await expect(client.callTool({ name, arguments: {} })).resolves.toEqual({
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      });
      expect(requests).toHaveLength(before);
    },
  );
});

describe("MCP action admission over stdio", () => {
  it.each(["orcy_habitat", "orcy_review"])("rejects inherited action names for %s", async (name) => {
    const before = requests.length;
    for (const action of ["constructor", "toString", "__proto__", "hasOwnProperty", "unknown_action"]) {
      const result = await client.callTool({ name, arguments: { action } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(new RegExp(`^Unknown action: ${action}\\. Valid actions: `)) }]);
    }
    expect(requests).toHaveLength(before);
  });

  it.each([undefined, null, 12, false, [], ["list"], {}, { toString: "list" }, { constructor: "list" }])(
    "rejects malformed or missing action %# without coercion or reflecting its contents",
    async (action) => {
      const before = requests.length;
      const result = await client.callTool({ name: "orcy_habitat", arguments: action === undefined ? {} : { action } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(action === undefined ? /^Unknown action: undefined\. Valid actions: / : /^Action must be a string\. Valid actions: /) }]);
      expect(requests).toHaveLength(before);
    },
  );

  it.each([null, [], "list", 12])("outer invalid arguments %# receive a protocol schema error", async (args) => {
    const before = requests.length;
    // The SDK owns outer request parsing. Its current schema exceptions use
    // -32603 rather than -32602; this test promises rejection, not that mapping.
    await expect(client.callTool({ name: "orcy_habitat", arguments: args as any })).rejects.toBeInstanceOf(McpError);
    expect(requests).toHaveLength(before);
  });

  it("preserves a registered required-parameter error", async () => {
    const before = requests.length;
    const result = await client.callTool({ name: "orcy_review", arguments: { action: "list_rules" } });
    expect(result).toEqual({
      content: [{ type: "text", text: 'Action "list_rules" is missing required parameters: habitatId' }],
      isError: true,
    });
    expect(requests).toHaveLength(before);
  });

  it("dispatches a valid action through the real API client after malformed calls", async () => {
    const before = requests.length;
    const result = await client.callTool({ name: "orcy_habitat", arguments: { action: "list" } });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ habitats: [{ id: "wire-habitat", name: "Wire", description: "Dispatch control" }] }, null, 2) }]);
    expect(requests.slice(before)).toEqual(["GET /api/habitats"]);
  });

  it("still serves a registered tool without an action", async () => {
    const before = requests.length;
    const result = await client.callTool({ name: "orcy_instructions", arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect((result.content as Array<{ text: string }>)[0].text.length).toBeGreaterThan(100);
    expect(requests).toHaveLength(before);
  });
});
