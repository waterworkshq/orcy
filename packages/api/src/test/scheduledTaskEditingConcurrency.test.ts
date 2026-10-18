import { afterEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, getDb, initDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as scheduleRepo from "../repositories/scheduledTask.js";
import { listOccurrencesForScheduleWithClient } from "../repositories/scheduledOccurrences.js";
import { useCompiledApi } from "./compiledApiFixture.js";

// Native WAL connections in separate OS processes. Source-route tests prove
// callers use this same compiled production edit/reservation transaction seam.
const fixture = useCompiledApi();
let directory: string | undefined;
const workers: ChildProcess[] = [];
const exits = new Map<ChildProcess, Promise<void>>();
afterEach(async () => {
  for (const child of workers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(workers.map((child) => exits.get(child)));
  workers.length = 0; exits.clear(); closeDb();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function worker(file: string, id: string, mode: string, payload: object = {}) {
  const child = fork(join(import.meta.dirname, "fixtures", "scheduled-task-edit-worker.mjs"),
    [fixture.distDir, file, id, mode, JSON.stringify(payload)], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  workers.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const messages: Record<string, any>[] = [];
  child.on("message", (message) => { messages.push(message as Record<string, any>); });
  exits.set(child, new Promise<void>((resolve) => child.once("exit", () => resolve())));
  async function until(type: string) {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      const result = messages.find((message) => message.type === type);
      if (result) return result;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited before ${type}: ${stderr}`);
      await delay(10);
    }
    throw new Error(`Worker timeout waiting for ${type}: ${stderr}`);
  }
  return { child, messages, until };
}

describe("one-shot edits serialized with native reservation", () => {
  it.each([{ enabled: true }, { scheduledAt: "2026-10-18T14:00:00.000Z" }])(
    "re-reads consumption after an overlapping reservation commits (%j)", async (payload) => {
      directory = mkdtempSync(join(tmpdir(), "orcy-schedule-edit-"));
      const file = join(directory, "scheduler.db");
      await initDb(file);
      const habitat = habitatRepo.createHabitat({ name: "Native edit race" });
      const saved = scheduleRepo.createScheduledTask({ habitatId: habitat.id, name: "Once", missionTitle: "Once",
        scheduleType: "once", scheduledAt: "2026-10-18T12:00:00.000Z", nextRunAt: "2026-10-18T12:00:00.000Z", createdBy: "scheduler" });
      closeDb();
      const reservation = worker(file, saved.id, "reserve");
      const edit = worker(file, saved.id, "edit", payload);
      await Promise.all([reservation.until("READY"), edit.until("READY")]);
      reservation.child.send({ type: "GO" });
      expect(await reservation.until("HELD")).toMatchObject({ outcome: "created" });
      edit.child.send({ type: "GO" });
      await edit.until("ATTEMPT");
      // The reservation owns the writer lock while the edit attempts admission.
      // The edit must wait, then inspect the newly committed once snapshot.
      await delay(150);
      expect(edit.messages.filter((message) => message.type === "RESULT")).toEqual([]);
      reservation.child.send({ type: "COMMIT" });
      expect(await edit.until("RESULT")).toMatchObject({ status: 409, code: "ONCE_SCHEDULE_CONSUMED" });
      await reservation.until("RESULT");
      await Promise.race([
        Promise.all([exits.get(edit.child), exits.get(reservation.child)]),
        delay(2_000).then(() => { throw new Error(`Workers did not exit: ${JSON.stringify([edit.messages, reservation.messages])}`); }),
      ]);
      expect(edit.child.exitCode).toBe(0);
      expect(reservation.child.exitCode).toBe(0);
      await initDb(file);
      expect(scheduleRepo.getScheduledTaskById(saved.id)).toMatchObject({ enabled: false, runCount: 1,
        nextRunAt: "9999-12-31T23:59:59.000Z" });
      expect(listOccurrencesForScheduleWithClient(getDb(), saved.id)).toMatchObject([
        { state: "reserved", scheduledFor: "2026-10-18T12:00:00.000Z" },
      ]);
      expect(listOccurrencesForScheduleWithClient(getDb(), saved.id)).toHaveLength(1);
    }, 30_000,
  );
});
