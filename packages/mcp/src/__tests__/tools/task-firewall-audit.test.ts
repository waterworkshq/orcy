/**
 * Audit-attribution firewall for `orcy_habitat_task`.
 *
 * `withAuditToolContext(toolName, action, cb)` is called in `index.ts`
 * (CallToolRequestSchema handler) AROUND the dispatch handler — NOT inside
 * `TASK_DISPATCH_HANDLER`. The contract this file locks: for every CallTool
 * request routed to `orcy_habitat_task`, the audit context receives the
 * unchanged pair `(toolName="orcy_habitat_task", action)` where `action` is the
 * raw `arguments.action` (string) or `undefined` when it is absent/non-string.
 *
 * SEAM CHOICE — why this file mocks the server bootstrap:
 * The action-extraction + `withAuditToolContext` call lives inline in the
 * `index.ts` CallTool handler, which is not exported and runs the full server
 * bootstrap (module-singleton `client`, `server`, `main()`). To exercise the
 * REAL `index.ts` code without touching production, we mock only the three
 * infrastructure dependencies the bootstrap needs to load inertly — the SDK
 * `Server` (to capture `setRequestHandler`), `StdioServerTransport`, and the
 * `KanbanApiClient` constructor (to return a client whose
 * `withAuditToolContext` records its args and runs the callback). Everything
 * else — `./tools/index.js`, the real `TASK_DISPATCH_HANDLER`, `dispatch-utils`
 * — runs UNMOCKED. So this captures the genuine production attribution path.
 *
 * No production code is modified. If `index.ts` ever stops forwarding
 * `(toolName, action)` unchanged, these tests fail.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Shared, hoisted ahead of the vi.mock factories so both the factories and the
// test body can reference the same client instance and call log.
const auditHarness = vi.hoisted(() => {
  const calls: Array<{ toolName: string; action: string | undefined }> = [];
  const client = {
    withAuditToolContext(toolName: string, action: string | undefined, cb: () => unknown): unknown {
      calls.push({ toolName, action });
      return cb();
    },
    // Minimal surface for the success-path handler (action=add-comment), which
    // delegates straight to client.addComment with no enrichment.
    addComment: async () => ({ comment: { id: "audit-c1", content: "ok" } }),
    getBaseUrl: () => "http://localhost:3000",
  };
  return { calls, client };
});

// The bootstrap's `new Server(...)` becomes a capturing stub; we read the
// registered CallTool handler off its setRequestHandler mock. The impl must be a
// `function` so the stub is constructible with `new`.
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn(function () {
    return {
      setRequestHandler: vi.fn(),
      connect: vi.fn(),
      notification: vi.fn(),
    };
  }),
}));

// Transport is inert so main()'s `server.connect(transport)` is a no-op.
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function () {
    return {};
  }),
}));

// The module-singleton `client` becomes our recording mock. Every other export
// of api.js is untouched (all tool modules import KanbanApiClient as type-only).
// A `function` body (not an arrow) is required so the mock is callable with `new`
// and returns the recording client instance as the constructed value.
vi.mock("../../api.js", () => ({
  KanbanApiClient: vi.fn(function () {
    return auditHarness.client;
  }),
}));

// types.js is deliberately NOT mocked — CallToolRequestSchema must keep its real
// object identity so we can match it against the registered handler.

describe("orcy_habitat_task — audit attribution (firewall)", () => {
  let callTool: (request: {
    params: { name: string; arguments: Record<string, unknown> };
  }) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

  beforeAll(async () => {
    // Loads the real index.ts; its top-level main() runs against the mocked
    // Server/Transport/Client and completes inertly.
    await import("../../index.js");

    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const serverInstance = vi.mocked(Server).mock.results[0]?.value;
    const registered = serverInstance.setRequestHandler.mock.calls as Array<
      [unknown, typeof callTool]
    >;
    const entry = registered.find(([schema]) => schema === CallToolRequestSchema);
    if (!entry) {
      throw new Error("CallToolRequestSchema handler was never registered by index.ts");
    }
    callTool = entry[1];
  });

  beforeEach(() => {
    auditHarness.calls.length = 0;
  });

  it("success path forwards (orcy_habitat_task, add-comment) and the wrapped handler runs", async () => {
    const result = await callTool({
      params: {
        name: "orcy_habitat_task",
        arguments: { action: "add-comment", taskId: "t1", content: "ok" },
      },
    });

    expect(auditHarness.calls).toEqual([{ toolName: "orcy_habitat_task", action: "add-comment" }]);
    // The callback ran → a real (non-error) result came back.
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
  });

  it("validation-failure path still forwards (orcy_habitat_task, add-comment) before the dispatch short-circuits", async () => {
    const result = await callTool({
      params: {
        name: "orcy_habitat_task",
        arguments: { action: "add-comment" },
      },
    });

    expect(auditHarness.calls).toEqual([{ toolName: "orcy_habitat_task", action: "add-comment" }]);
    // Dispatch rejected the missing params; the audit context still observed the action.
    expect(result.isError).toBe(true);
  });

  it("unknown-action path forwards (orcy_habitat_task, does-not-exist)", async () => {
    const result = await callTool({
      params: {
        name: "orcy_habitat_task",
        arguments: { action: "does-not-exist" },
      },
    });

    expect(auditHarness.calls).toEqual([
      { toolName: "orcy_habitat_task", action: "does-not-exist" },
    ]);
    expect(result.isError).toBe(true);
  });

  it("non-string action forwards action=undefined (index.ts extraction: typeof action !== 'string')", async () => {
    await callTool({
      params: {
        name: "orcy_habitat_task",
        arguments: { action: 42 },
      },
    });

    expect(auditHarness.calls).toEqual([{ toolName: "orcy_habitat_task", action: undefined }]);
  });

  it("absent action forwards action=undefined", async () => {
    await callTool({
      params: {
        name: "orcy_habitat_task",
        arguments: {},
      },
    });

    expect(auditHarness.calls).toEqual([{ toolName: "orcy_habitat_task", action: undefined }]);
  });
});
