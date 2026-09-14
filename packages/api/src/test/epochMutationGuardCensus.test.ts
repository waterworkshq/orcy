/**
 * Epoch mutation guard — served-surface census (ticket I2).
 *
 * Grep-verifiable census: EVERY in-tree caller of the four guarded service
 * entries is either
 *   (a) the agent HTTP routes (routes/tasks/lifecycle.ts — guarded, threads
 *       the body token), or
 *   (b) a STRUCTURAL server-actor site (separate identity; never routes
 *       through the agent wire), enumerated below, or
 *   (c) the daemon session machinery (no token needed — sessions are not
 *       agent wire), or
 *   (d) tests / the race-worker fixture.
 *
 * A NEW in-tree caller that reaches one of the four mutations outside these
 * buckets must fail this census — a new duplicate surface cannot ship
 * unfenced.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PACKAGES = join(ROOT, "packages");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Callers allowed WITHOUT threading a token (structural server actors). */
const STRUCTURAL_EXCLUSIONS: Array<{ file: string; hint: string }> = [
  // Stale-agent sweep + agent-deletion release (system actor).
  { file: "packages/api/src/services/agentService.ts", hint: "taskRepo.releaseTask" },
  // Automation executor release (system actor).
  { file: "packages/api/src/services/automationExecutor.ts", hint: "taskRepo.releaseTask" },
  // Plugin runtime context release (system actor).
  { file: "packages/api/src/plugins/context.ts", hint: "taskStateMachine.releaseTask" },
  // The service/repo implementations themselves + the service-internal
  // delegation from service → repo (the guard predicate lives there).
  { file: "packages/api/src/repositories/taskStateMachine.ts", hint: "definitions" },
  {
    file: "packages/api/src/services/tasks/task-lifecycle.ts",
    hint: "definitions + service→repo delegation",
  },
  // The remote seam (separate identity — excluded by the ticket).
  {
    file: "packages/api/src/services/tasks/remote-task-lifecycle.ts",
    hint: "remote participant seam",
  },
];

const isTest = (f: string) =>
  f.includes("/test/") || f.includes("/__tests__/") || f.endsWith(".test.ts");
const isExcluded = (f: string) =>
  STRUCTURAL_EXCLUSIONS.some((e) => f.endsWith(e.file)) ||
  f.endsWith("packages/api/src/routes/tasks/lifecycle.ts") || // THE guarded agent route
  f.endsWith("packages/api/src/repositories/claimAuthority.ts") || // authority primitives
  f.endsWith("packages/api/src/services/effects/failureEffects.ts") || // act-tx primitive
  f.endsWith("packages/mcp/src/api.ts") || // HTTP client (threads token — verified by mcp unit tests)
  f.endsWith("packages/mcp/src/api/interfaces.ts") ||
  f.endsWith("packages/daemon/src/api-client.ts"); // daemon control API (not agent mutations)

const MUTATION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /taskService\.startTask\(|taskStateMachine\.startTask\(|taskRepo\.startTask\(/,
    label: "startTask",
  },
  {
    re: /taskService\.submitTask\(|taskStateMachine\.submitTask\(|taskRepo\.submitTask\(/,
    label: "submitTask",
  },
  {
    re: /taskService\.releaseTask\(|taskStateMachine\.releaseTask\(|taskRepo\.releaseTask\(/,
    label: "releaseTask",
  },
  { re: /taskService\.failTask\(|taskStateMachine\.failTask\(/, label: "failTask" },
];

describe("epoch mutation guard — served-surface census", () => {
  it("no unlisted non-test caller reaches the four guarded mutations", () => {
    const offenders: string[] = [];
    for (const file of walk(PACKAGES)) {
      if (isTest(file) || isExcluded(file)) continue;
      const text = readFileSync(file, "utf-8");
      for (const { re, label } of MUTATION_PATTERNS) {
        if (re.test(text)) offenders.push(`${file}: ${label}`);
      }
    }
    expect(offenders, `unfenced callers: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the guarded agent routes thread an executionToken into all four service calls", () => {
    const routeFile = readFileSync(
      join(ROOT, "packages/api/src/routes/tasks/lifecycle.ts"),
      "utf-8",
    );
    expect(routeFile).toMatch(/startTask\([^)]*parsed\??\.executionToken/s);
    expect(routeFile).toMatch(/submitTask\([^)]*parsed\.executionToken/s);
    expect(routeFile).toMatch(/failTask\([^)]*parsed\.executionToken/s);
    expect(routeFile).toMatch(/releaseTask\([^)]*parsed\.executionToken/s);
  });

  it("the MCP client interface threads executionToken on the four mutations and NOT on claim", () => {
    const iface = readFileSync(join(ROOT, "packages/mcp/src/api/interfaces.ts"), "utf-8");
    expect(iface).toMatch(/startTask\(\s*taskId: string,\s*executionToken\??:/s);
    expect(iface).toMatch(/failTask\(\s*taskId: string,\s*reason: string,\s*executionToken\??:/s);
    expect(iface).toMatch(
      /submitTask\(\s*taskId: string,\s*result: string,\s*artifacts\?[^)]*executionToken\??:/s,
    );
    expect(iface).toMatch(
      /releaseTask\(\s*taskId: string,\s*reason: string,\s*executionToken\??:/s,
    );
    // claim gains no token input (up to the next doc comment — startTask's
    // own token doc must not leak into claim's section)
    const claimStart = iface.indexOf("claimTask(");
    const claimSection = iface.slice(claimStart, iface.indexOf("\n  /**", claimStart));
    expect(claimSection).not.toContain("executionToken");
  });

  it("shared ClaimResult carries the execution token for daemon claim surfaces", () => {
    const shared = readFileSync(join(ROOT, "packages/shared/src/types/daemon.ts"), "utf-8");
    const claimResult = shared.slice(
      shared.indexOf("export interface ClaimResult"),
      shared.indexOf("export interface RegisteredAgent"),
    );
    expect(claimResult).toContain("executionToken");
  });

  it("ClaimNextDaemonTaskResult carries the execution token", () => {
    const engine = readFileSync(join(ROOT, "packages/api/src/services/daemonEngine.ts"), "utf-8");
    const section = engine.slice(engine.indexOf("export type ClaimNextDaemonTaskResult"));
    expect(section.slice(0, 800)).toContain("executionToken");
  });
});
