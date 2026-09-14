/**
 * Epoch mutation guard — CLI `--execution-token` threading (F2).
 *
 * Meaningful command→HTTP payload tests for the four bundled agent-client
 * mutations (`orcy task start/submit/release/fail`):
 *   - `--execution-token` value lands in the body VERBATIM, field spelled
 *     exactly `executionToken` (no kebab-case leak, no undefined-serialize)
 *   - flag missing → field ABSENT from the payload (start sends NO body at
 *     all — the route's historical no-body shape); the server then 409s
 *     tokened tasks (surfaced as the CLI's API error), never a silent pass
 *   - no other body fields are disturbed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

const mockPost = vi.hoisted(() => vi.fn());

vi.mock("../src/client.js", () => ({
  api: {
    get: vi.fn(),
    post: mockPost,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { registerTaskCommands } from "../src/commands/task.js";

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerTaskCommands(program);
  return program;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPost.mockResolvedValue({ task: { id: "t" } });
});

describe("orcy task start — execution token payload", () => {
  it("no flag → NO body at all (no Content-Type wire shape)", () => {
    createProgram().parse(["node", "orcy", "task", "start", "task-1"]);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe("/api/tasks/task-1/start");
    expect(body).toBeUndefined();
  });

  it("--execution-token → verbatim single-field body, exact spelling", () => {
    createProgram().parse([
      "node",
      "orcy",
      "task",
      "start",
      "task-1",
      "--execution-token",
      "tok-abc-123",
    ]);
    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe("/api/tasks/task-1/start");
    expect(body).toEqual({ executionToken: "tok-abc-123" });
  });
});

describe("orcy task submit — execution token payload", () => {
  it("no flag → no executionToken key in the payload", () => {
    createProgram().parse(["node", "orcy", "task", "submit", "task-1", "--result", "done"]);
    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe("/api/tasks/task-1/submit");
    expect(body).toEqual({ result: "done", artifacts: [] });
    expect("executionToken" in body).toBe(false);
  });

  it("--execution-token → verbatim alongside result/artifacts", () => {
    createProgram().parse([
      "node",
      "orcy",
      "task",
      "submit",
      "task-1",
      "--result",
      "done",
      "--execution-token",
      "tok-abc-123",
    ]);
    const [, body] = mockPost.mock.calls[0];
    expect(body).toEqual({ result: "done", artifacts: [], executionToken: "tok-abc-123" });
  });
});

describe("orcy task release — execution token payload", () => {
  it("no flag → no executionToken key", () => {
    createProgram().parse(["node", "orcy", "task", "release", "task-1", "--reason", "blocked"]);
    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe("/api/tasks/task-1/release");
    expect(body).toEqual({ reason: "blocked" });
    expect("executionToken" in body).toBe(false);
  });

  it("--execution-token → verbatim alongside reason", () => {
    createProgram().parse([
      "node",
      "orcy",
      "task",
      "release",
      "task-1",
      "--reason",
      "blocked",
      "--execution-token",
      "tok-abc-123",
    ]);
    const [, body] = mockPost.mock.calls[0];
    expect(body).toEqual({ reason: "blocked", executionToken: "tok-abc-123" });
  });
});

describe("orcy task fail — execution token payload", () => {
  it("no flag → no executionToken key", () => {
    createProgram().parse(["node", "orcy", "task", "fail", "task-1", "stuck"]);
    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe("/api/tasks/task-1/fail");
    expect(body).toEqual({ reason: "stuck" });
    expect("executionToken" in body).toBe(false);
  });

  it("--execution-token → verbatim alongside reason", () => {
    createProgram().parse([
      "node",
      "orcy",
      "task",
      "fail",
      "task-1",
      "stuck",
      "--execution-token",
      "tok-abc-123",
    ]);
    const [, body] = mockPost.mock.calls[0];
    expect(body).toEqual({ reason: "stuck", executionToken: "tok-abc-123" });
  });

  it("empty-string token is forwarded verbatim (client decides, CLI never guesses)", () => {
    createProgram().parse([
      "node",
      "orcy",
      "task",
      "fail",
      "task-1",
      "stuck",
      "--execution-token",
      "",
    ]);
    const [, body] = mockPost.mock.calls[0];
    expect(body).toEqual({ reason: "stuck", executionToken: "" });
  });
});

describe("orcy task approve — review decision command", () => {
  it("calls POST /api/tasks/:id/approve with empty-object body; no reviewerId in body", () => {
    createProgram().parse(["node", "orcy", "task", "approve", "task-1"]);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe("/api/tasks/task-1/approve");
    expect(body).toEqual({});
  });
});

describe("orcy task reject — review decision command", () => {
  it("requires --reason flag; rejects invocation without it", () => {
    expect(() => {
      createProgram().parse(["node", "orcy", "task", "reject", "task-1"]);
    }).toThrow();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("calls POST /api/tasks/:id/reject with reason in body; no reviewerId spoofing", () => {
    createProgram().parse([
      "node",
      "orcy",
      "task",
      "reject",
      "task-1",
      "--reason",
      "Tests are failing",
    ]);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body] = mockPost.mock.calls[0];
    expect(path).toBe("/api/tasks/task-1/reject");
    expect(body).toEqual({ reason: "Tests are failing" });
    expect("reviewerId" in body).toBe(false);
  });
});
