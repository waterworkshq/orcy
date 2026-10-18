import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, getDb, initDb } from "../db/index.js";
import { missions, tasks, scheduledOccurrences, taskCreationAttempts } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as scheduleRepo from "../repositories/scheduledTask.js";
import { useCompiledApi } from "./compiledApiFixture.js";
const fixture = useCompiledApi();
let directory: string | undefined;
const children: ChildProcess[] = [];
const exits = new Map<ChildProcess, Promise<void>>();
afterEach(async () => {
  for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(children.map((child) => exits.get(child)));
  children.length = 0; exits.clear(); closeDb();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
function worker(file: string, id: string, coordinate: string, mode: string, release: string) {
  const child = fork(join(import.meta.dirname, "fixtures/manual-schedule-worker.mjs"),
    [fixture.distDir, file, id, coordinate, mode, release], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child);
  let stderr = ""; let failure: Error | undefined;
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const messages: Record<string, any>[] = [];
  child.on("message", (message) => messages.push(message as Record<string, any>));
  exits.set(child, new Promise<void>((resolve) => {
    child.once("exit", () => resolve()); child.once("error", (error) => { failure = error; resolve(); });
  }));
  async function until(type: string) {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const result = messages.find((message) => message.type === type);
      if (result) return result;
      if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker ended before ${type}: ${failure?.message ?? stderr} ${JSON.stringify(messages)}`);
      await delay(10);
    }
    throw new Error(`Worker timeout ${type}: ${stderr} ${JSON.stringify(messages)}`);
  }
  return { child, messages, until };
}

describe("native manual/polling reservation contention", () => {
  it.each([
    { first: "manual-hold", second: "manual", coordinate: "2090-01-01T13:00:00.000Z" },
    { first: "manual-hold", second: "poll", coordinate: "2000-01-01T13:00:00.000Z" },
    { first: "poll-hold", second: "manual", coordinate: "2000-01-01T13:00:00.000Z" },
  ])("serializes $first against $second on one exact pair with one publication", async ({ first, second, coordinate }) => {
    directory = mkdtempSync(join(tmpdir(), "orcy-manual-contention-"));
    const file = join(directory, "scheduler.db");
    const release = join(directory, "release-holder");
    await initDb(file);
    const habitat = habitatRepo.createHabitat({ name: "Manual contention" });
    columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog", order: 0, requiresClaim: false });
    const schedule = scheduleRepo.createScheduledTask({ habitatId: habitat.id, name: "Once", missionTitle: "Native manual mission",
      tasksTemplate: [{ title: "Native manual task" }], scheduleType: "once", scheduledAt: coordinate,
      nextRunAt: coordinate, createdBy: "operator" });
    closeDb();
    const holder = worker(file, schedule.id, coordinate, first, release);
    const holderReady = await holder.until("READY");
    expect(holderReady).toMatchObject({ journalMode: "wal", busyTimeout: 5000 });
    const contender = worker(file, schedule.id, coordinate, second, release);
    const contenderReady = await contender.until("READY");
    expect(contenderReady).toMatchObject({ journalMode: "wal", busyTimeout: 5000 });
    expect(holderReady.pid).not.toBe(contenderReady.pid);
    holder.child.send({ type: "GO" });
    await holder.until("HELD");
    contender.child.send({ type: "GO" });
    await contender.until("ATTEMPT");
    // Genuine overlapping processes: second admission blocks behind an owned
    // writer transaction, rather than two synchronous calls in one event loop.
    await delay(150);
    expect(contender.messages.filter((message) => message.type === "RESULT")).toEqual([]);
    if (first === "poll-hold") holder.child.send({ type: "COMMIT" });
    else writeFileSync(release, "release");
    const results = await Promise.all([holder.until("RESULT"), contender.until("RESULT")]);
    expect(results.map((result) => result.status), JSON.stringify(results)).toEqual([undefined, undefined]);
    await Promise.race([Promise.all([exits.get(holder.child), exits.get(contender.child)]), delay(2000).then(() => { throw new Error("Workers did not exit"); })]);
    expect(holder.child.exitCode).toBe(0); expect(contender.child.exitCode).toBe(0);
    if (first === "manual-hold") expect(results[0].result).toMatchObject({ success: true, replayed: false, occurrenceState: "published" });
    else expect(results[0].outcome).toBe("published");
    if (second === "manual") expect(results[1].result).toMatchObject({ success: true, replayed: true });
    await initDb(file);
    const db = getDb();
    const occurrences = db.select().from(scheduledOccurrences).all();
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ scheduledFor: coordinate, state: "published", ordinal: 0 });
    const attempts = db.select().from(taskCreationAttempts).all();
    expect(attempts.filter((attempt) => attempt.publicationKind === "scheduled_occurrence" &&
      attempt.sourceScopeId === occurrences[0].id && attempt.attemptKey === "occurrence")).toHaveLength(1);
    // One coordination attempt plus one Task attempt, both share publication kind.
    expect(attempts).toHaveLength(2);
    expect(db.select().from(missions).all()).toHaveLength(1);
    expect(db.select().from(tasks).all()).toHaveLength(1);
    expect(scheduleRepo.getScheduledTaskById(schedule.id)).toMatchObject({ enabled: false, runCount: 1, nextRunAt: "9999-12-31T23:59:59.000Z" });
    if (first === "manual-hold") expect(occurrences[0].scheduleRevision?._manualTrigger).toMatchObject({ actorId: "native-first-human", scheduledFor: coordinate });
    else expect(occurrences[0].scheduleRevision?._manualTrigger).toBeUndefined();
  }, 45000);
});
