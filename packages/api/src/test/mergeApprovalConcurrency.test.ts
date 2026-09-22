import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Worker } from "node:worker_threads";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

/**
 * REC-06 addendum-2 pin: two same-payload signed merged deliveries racing on
 * a REAL file-backed SQLite database through separate connections (worker
 * threads, one `initDb` each) must produce exactly ONE approval event and
 * exactly ONE version bump. The `BEGIN IMMEDIATE` transaction is the IPC
 * barrier: the winner commits approve+event; the loser's in-transaction
 * preimage read sees `approved` and returns with zero writes.
 *
 * Runs against the compiled `dist` build (each worker imports its own module
 * instance → its own connection), not the vitest src registry.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const distRoot = join(here, "..", "..", "dist");
const dbModuleUrl = pathToFileURL(join(distRoot, "db", "index.js")).href;
const githubModuleUrl = pathToFileURL(join(distRoot, "services", "githubWebhook.js")).href;

const GH_SECRET = "race-test-secret";
const REPO_ID = 192837465;
const TASK_PATTERN = "mission/([0-9a-f-]{36})";

const WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
import { existsSync } from "node:fs";
import { initDb, closeDb } from "${dbModuleUrl}";
import { handlePullRequestEvent } from "${githubModuleUrl}";

const { dbPath, gateFile, payload, ingress } = workerData;
await initDb(dbPath);
parentPort.postMessage("ready");
while (!existsSync(gateFile)) {
  await new Promise((r) => setTimeout(r, 1));
}
const result = handlePullRequestEvent(payload, ingress);
await closeDb();
parentPort.postMessage({ status: result.status });
`;

let workDir: string;

describe("merge approval concurrency — file SQLite IPC barrier", () => {
  let dbPath: string;
  let taskId: string;
  let baseVersion: number;
  let payload: unknown;
  let ingress: { rawBody: string; signature: string };

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "orcy-merge-race-"));
    dbPath = join(workDir, "race.db");

    const dbModule = await import(dbModuleUrl);
    await dbModule.initDb(dbPath);
    const db = dbModule.getDb();

    const habitatRepo = await import(
      pathToFileURL(join(distRoot, "repositories", "habitat.js")).href
    );
    const columnRepo = await import(
      pathToFileURL(join(distRoot, "repositories", "column.js")).href
    );
    const missionRepo = await import(
      pathToFileURL(join(distRoot, "repositories", "mission.js")).href
    );
    const taskRepo = await import(pathToFileURL(join(distRoot, "repositories", "task.js")).href);

    const habitat = habitatRepo.createHabitat({ name: "race" });
    const { habitats } = await import(
      pathToFileURL(join(distRoot, "db", "schema", "index.js")).href
    );
    const { eq } = await import("drizzle-orm");
    db.update(habitats)
      .set({
        codeReviewSettings: {
          autoApproveOnMerge: true,
          githubSecret: GH_SECRET,
          gitlabSecret: null,
          taskPattern: TASK_PATTERN,
          githubRepositories: [{ id: String(REPO_ID), fullName: "example/race" }],
          gitlabProjects: [],
        },
      })
      .where(eq(habitats.id, habitat.id))
      .run();

    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "race mission",
      createdBy: "user-race",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "race task",
      createdBy: "user-race",
    });
    taskRepo.updateTask(task.id, { status: "submitted" });
    taskId = task.id;
    baseVersion = taskRepo.getTaskById(taskId).version;

    // Link-record idempotency asserted BEFORE the auto-approve bundle: the
    // racing merged deliveries must find an existing PR row.
    const prRepo = await import(
      pathToFileURL(join(distRoot, "repositories", "pullRequest.js")).href
    );
    prRepo.createPullRequest({
      taskId,
      provider: "github",
      repo: "example/race",
      prNumber: 303,
      prTitle: "race",
      prUrl: "https://github.com/example/race/pull/303",
      branchName: `mission/${taskId}`,
      state: "open",
    });
    await dbModule.closeDb();

    payload = {
      action: "closed",
      number: 303,
      pull_request: {
        title: "race",
        html_url: "https://github.com/example/race/pull/303",
        state: "closed",
        merged: true,
        head: { ref: `mission/${taskId}` },
        base: { repo: { id: REPO_ID, full_name: "example/race" } },
      },
    };
    const rawBody = JSON.stringify(payload);
    ingress = {
      rawBody,
      signature: `sha256=${createHmac("sha256", GH_SECRET).update(rawBody).digest("hex")}`,
    };
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("two concurrent signed merged deliveries → one approval event, one version bump", async () => {
    const workerFile = join(workDir, "worker.mjs");
    writeFileSync(workerFile, WORKER_SOURCE, "utf8");
    const gateFile = join(workDir, "gate.lock");

    const spawn = () =>
      new Promise<{ status: string }>((resolve, reject) => {
        const worker = new Worker(workerFile, {
          workerData: { dbPath, gateFile, payload, ingress },
        });
        worker.on("message", (m: unknown) => {
          if (m === "ready") return;
          resolve(m as { status: string });
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`worker exited ${code}`));
        });
      });

    const results = [spawn(), spawn()];
    // Give both workers time to init and reach the gate.
    await new Promise((r) => setTimeout(r, 1500));
    writeFileSync(gateFile, "go", "utf8");
    const settled = await Promise.all(results);
    expect(settled.map((r) => r.status)).toEqual(["closed", "closed"]);
    const dbModule = await import(dbModuleUrl);
    await dbModule.initDb(dbPath);
    const eventRepo = await import(pathToFileURL(join(distRoot, "repositories", "event.js")).href);
    const approvedEvents = eventRepo
      .getEventsByTaskId(taskId)
      .events.filter((e: { action: string }) => e.action === "approved");
    expect(approvedEvents).toHaveLength(1);
    const taskRepo = await import(pathToFileURL(join(distRoot, "repositories", "task.js")).href);
    const task = taskRepo.getTaskById(taskId);
    expect(task.status).toBe("approved");
    expect(task.version).toBe(baseVersion + 1);
    await dbModule.closeDb();
  }, 30000);
});
