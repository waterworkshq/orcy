import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SKILL_CATEGORIES } from "@orcy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("built CLI entry", () => {
  let home: string;
  let server: Server;
  let apiUrl: string;
  const requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = [];

  beforeAll(async () => {
    execFileSync("corepack", ["pnpm", "--filter", "@orcy/cli...", "build"], {
      cwd: resolve(import.meta.dirname, "../../.."),
      stdio: "inherit",
    });
    home = mkdtempSync(join(tmpdir(), "orcy-cli-entry-"));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    if (home) rmSync(home, { recursive: true, force: true });
  });

  function run(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [resolveEntry(), ...args], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, ORCY_API_URL: apiUrl, ORCY_API_KEY: "synthetic" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  function resolveEntry() { return resolve(import.meta.dirname, "../dist/index.js"); }

  it("handles root help, version, and unrelated command help", async () => {
    for (const [args, expected] of [
      [["--help"], "Orcy — orchestrate your AI fleet"],
      [["--version"], "1.0.0"],
      [["task", "--help"], "Usage: orcy task"],
      [["skill", "contribute", "--help"], "--category <category>"],
    ] as const) {
      const result = await run(...args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(expected);
    }
  });

  it("runs an unrelated command through argument handling", async () => {
    const result = await run("task", "list-in-mission", "mission-test");
    expect(result.code, result.stderr).toBe(0);
    expect(requests).toEqual([{ method: "GET", url: "/api/missions/mission-test/tasks", body: undefined }]);
    requests.length = 0;
  });

  it("sends each supported category and rejects an invalid one before a request", async () => {
    for (const category of SKILL_CATEGORIES) {
      const result = await run("skill", "contribute", "habitat-test", "--insight", "test insight", "--category", category);
      expect(result.code, result.stderr).toBe(0);
      expect(requests.at(-1)).toEqual({ method: "POST", url: "/api/habitats/habitat-test/skill/contribute", body: { insight: "test insight", skillCategory: category } });
    }
    expect(requests).toHaveLength(SKILL_CATEGORIES.length);
    const omitted = await run("skill", "contribute", "habitat-test", "--insight", "test insight");
    expect(omitted.code, omitted.stderr).toBe(0);
    expect(requests.at(-1)).toEqual({ method: "POST", url: "/api/habitats/habitat-test/skill/contribute", body: { insight: "test insight" } });
    const result = await run("skill", "contribute", "habitat-test", "--insight", "test insight", "--category", "unsupported-category");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unsupported-category");
    expect(requests).toHaveLength(SKILL_CATEGORIES.length + 1);
  });
});
