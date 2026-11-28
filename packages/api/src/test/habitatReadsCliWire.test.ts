/**
 * CLI Habitat reads cross the production HTTP/auth chain (#280).
 *
 * The served Habitat routes live under `/habitats`; the CLI group had stayed
 * on the retired `/api/boards` paths, so every read 404'd for a valid agent.
 * Each read runs twice, as a child process with a real agent key against the
 * REAL assembled API on a TCP socket (no mocks): through the production
 * Habitat registrar alone, and through the full CLI entry whose startup #272
 * unblocked.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as columnRepo from "../repositories/column.js";
import * as eventRepo from "../repositories/event.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";

const CLI_ROOT = join(import.meta.dirname, "..", "..", "..", "cli");
// The root entry registers every command group before parsing, so an
// unrelated group's startup failure would mask Habitat behaviour (the #272
// failure mode). This harness registers the Habitat group alone.
const REGISTRAR_ONLY = [
  "--input-type=module",
  "--eval",
  `import { Command } from "commander";
   import { registerHabitatCommands } from ${JSON.stringify(pathToFileURL(join(CLI_ROOT, "src", "commands", "habitat.ts")).href)};
   const program = new Command().name("orcy");
   registerHabitatCommands(program);
   await program.parseAsync([process.argv[0], "orcy", ...process.argv.slice(1)]);`,
];
const ENTRIES = {
  "Habitat registrar": REGISTRAR_ONLY,
  "CLI entry": [join(CLI_ROOT, "src", "index.ts")],
} as const;
const MISSING_HABITAT = "00000000-0000-4000-8000-000000000000";

let app: HttpRuntimeHandle;
let baseUrl: string;
let home: string;
let apiKey: string;
let sprintId: string;
let platformId: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

type Run = { code: number | null; stdout: string; stderr: string };

/** Runs one `orcy` invocation; `key` omitted means no credential is sent. */
function cli(entry: readonly string[], args: string[], key?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...entry, ...args], {
      cwd: CLI_ROOT,
      // Disposable home: the CLI reads fallback credentials from $HOME/.orcy/.env.
      env: { PATH: process.env.PATH, HOME: home, ORCY_API_URL: baseUrl, ...(key ? { ORCY_API_KEY: key } : {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** What the same agent gets from the served route directly. */
async function served(path: string): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { "x-agent-api-key": apiKey } });
  expect(response.status).toBe(200);
  return response.json();
}

/** Summary minus the per-request clock values, so two reads of one contract compare equal. */
function comparable(summary: any) {
  const { generatedAt, recentActivity, ...rest } = summary;
  return {
    ...rest,
    recentActivity: recentActivity.map(({ from, to, ...period }: Record<string, unknown>) => period),
  };
}

/** Asserts the CLI prints exactly what the served route returns (`normalize` applied to both), and returns it. */
async function read(
  entry: readonly string[],
  args: string[],
  path: string,
  normalize: (body: any) => any = (body) => body,
): Promise<any> {
  const { code, stdout, stderr } = await cli(entry, args, apiKey);
  expect(code, stderr).toBe(0);
  const body = JSON.parse(stdout);
  expect(normalize(body)).toEqual(normalize(await served(path)));
  return body;
}

const narratives = (summary: any) => summary.recentActivity.flatMap((period: any) => period.missionNarratives);
const ids = (body: { habitats: Array<{ id: string }> }) => body.habitats.map((habitat) => habitat.id);

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;
  home = mkdtempSync(join(tmpdir(), "orcy-cli-habitat-"));

  apiKey = agentRepo.createAgent({
    name: "habitat-read-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).plainApiKey;
  sprintId = habitatRepo.createHabitat({ name: "sprint-planning" }).id;
  platformId = habitatRepo.createHabitat({ name: "platform core" }).id;
  const column = columnRepo.createColumn({ habitatId: sprintId, name: "todo" });
  // Two narrated missions make the summary's --max-tasks cap observable.
  for (const title of ["restore habitat reads", "wire the CLI entry"]) {
    const mission = missionRepo.createMission({
      habitatId: sprintId,
      columnId: column.id,
      title,
      createdBy: "system",
    });
    eventRepo.createMissionEvent({
      missionId: mission.id,
      actorType: "human",
      actorId: "system",
      action: "created",
      metadata: {},
    });
  }
});

afterAll(async () => {
  await app?.close();
  await closeDb();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe.each(Object.entries(ENTRIES))("Habitat reads through the %s", (_name, entry) => {
  it("list returns the served habitats", async () => {
    const body = await read(entry, ["habitat", "list"], "/api/habitats");
    expect(ids(body).sort()).toEqual([platformId, sprintId].sort());
  }, 30_000);

  it("find narrows the list by the search term", async () => {
    const body = await read(entry, ["habitat", "find", "platform core"], "/api/habitats?name=platform%20core");
    expect(ids(body)).toEqual([platformId]);
  }, 30_000);

  it("get-settings returns the habitat detail", async () => {
    const body = await read(entry, ["habitat", "get-settings", sprintId], `/api/habitats/${sprintId}`);
    expect(body.habitat.id).toBe(sprintId);
    expect(body.columns.map((column: { name: string }) => column.name)).toEqual(["todo"]);
    expect(body.missions.map((mission: { title: string }) => mission.title)).toEqual([
      "restore habitat reads",
      "wire the CLI entry",
    ]);
  }, 30_000);

  it("summary forwards since, max-tasks and --no-digest", async () => {
    const narrow = await read(
      entry,
      ["habitat", "summary", sprintId, "--since", "24h", "--max-tasks", "1", "--no-digest"],
      `/api/habitats/${sprintId}/summary?since=24h&maxTasks=1&includeDigest=false`,
      comparable,
    );
    expect(narrow.recentActivity.map((period: any) => period.period)).toEqual(["last_24h"]);
    expect(narratives(narrow)).toHaveLength(1);
    expect(narrow.digest).toBe("");
    // Without options the same read keeps the server defaults.
    const full = await read(entry, ["habitat", "summary", sprintId], `/api/habitats/${sprintId}/summary`, comparable);
    expect(narratives(full)).toHaveLength(2);
    expect(full.digest).not.toBe("");
  }, 30_000);

  it("metrics returns the habitat time metrics", async () => {
    const body = await read(entry, ["habitat", "metrics", sprintId], `/api/habitats/${sprintId}/metrics`);
    expect(body).toMatchObject({ totalPlannedMinutes: 0, agentMetrics: [] });
  }, 30_000);

  it("surfaces the API's authentication, not-found and validation failures", async () => {
    const authentication = "Authentication failed. Check that ORCY_API_KEY is set correctly.";
    const anonymous = await cli(entry, ["habitat", "list"]);
    expect(anonymous.code).toBe(1);
    expect(anonymous.stderr).toContain(authentication);
    const forged = await cli(entry, ["habitat", "get-settings", sprintId], "synthetic-invalid-key");
    expect(forged.code).toBe(1);
    expect(forged.stderr).toContain(authentication);
    const missing = await cli(entry, ["habitat", "summary", MISSING_HABITAT], apiKey);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Resource not found. Check the IDs you provided.");
    const invalid = await cli(entry, ["habitat", "summary", sprintId, "--since", "2h"], apiKey);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/^Client error: /m);
    expect(invalid.stdout).toBe("");
  }, 30_000);
});
