/**
 * GREEN characterization of the landed atomic task-metadata save core
 * (services/tasks/humanTaskMetadata.ts). Dual-driver persistence probes after
 * the completionPersistenceContract.test.ts fixture: trigger-forced write
 * failures, postimage equality, reservation release, and busy/lock mapping.
 * GROUND anchors throughout: PRD E6/E7/E11; DESIGN §5 (atomic save core) and
 * §7 (dual-driver persistence with RAISE(IGNORE)/RAISE(ABORT) triggers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, initDb, initTestDb } from "../db/index.js";
import { habitats, taskEvents, tasks, users } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as transitionEmitter from "../services/tasks/transition-emitter.js";
import {
  computeMetadataEditIdentityWithClient,
  saveTaskMetadata,
  saveTaskMetadataWithClient,
} from "../services/tasks/humanTaskMetadata.js";

function expectCause(error: unknown, text: string) {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current && typeof current === "object" && !seen.has(current);) {
    seen.add(current);
    const entry = current as { message?: unknown; cause?: unknown };
    messages.push(String(entry.message ?? ""));
    current = entry.cause;
  }
  expect(messages.join(" | ")).toContain(text);
}

function taskRow(id: string) {
  return taskRepo.getTaskById(id)!;
}
function allEvents(id: string) {
  return getDb().select().from(taskEvents).where(eq(taskEvents.taskId, id)).all();
}
function updatedEvents(id: string) {
  return allEvents(id).filter((event) => event.action === "updated");
}

/** Personal-habitat owner + pending unassigned task — the editable shape of PRD E3. */
function setup() {
  const db = getDb();
  const owner = randomUUID();
  db.insert(users).values({ id: owner, username: owner, passwordHash: "fixture", role: "editor" }).run();
  const habitat = habitatRepo.createHabitat({ name: "Metadata persistence" });
  // createHabitat cannot persist an owner (role administration owns that write) — set it directly.
  db.update(habitats).set({ ownerUserId: owner }).where(eq(habitats.id, habitat.id)).run();
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog", order: 0, requiresClaim: false });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: column.id, title: "Mission", createdBy: "fixture" });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", description: "body", priority: "medium", createdBy: "fixture" });
  return { owner, habitatId: habitat.id, missionId: mission.id, taskId: task.id };
}

type Fixture = ReturnType<typeof setup>;
type Priority = "low" | "medium" | "high" | "critical";

function baseline(f: Fixture) {
  const row = taskRow(f.taskId);
  return {
    expectedVersion: row.version,
    expectedTaskIdentity: computeMetadataEditIdentityWithClient(getDb(), {
      taskId: f.taskId,
      missionId: f.missionId,
      habitatId: f.habitatId,
      createdAt: row.createdAt,
    }),
  };
}

function save(f: Fixture, fields: { title?: string; description?: string; priority?: Priority; expectedPriority?: Priority }) {
  return saveTaskMetadata({ taskId: f.taskId, userId: f.owner, ...baseline(f), ...fields });
}

/**
 * Wraps the singleton client so its Nth raw `run` throws. The save core's raw
 * statements (BEGIN IMMEDIATE / COMMIT / ROLLBACK) are the only callers of the
 * drizzle wrapper's `run`; builder writes go through the session's own channel,
 * so run #1 is BEGIN and run #2 is COMMIT (success path) or ROLLBACK (refusal).
 */
function clientFailingOnNthRun(n: number, make: () => unknown): ReturnType<typeof getDb> {
  const real = getDb();
  let runs = 0;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "run") {
        return (...args: Parameters<typeof real.run>) => {
          runs += 1;
          if (runs === n) throw make();
          return real.run(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReturnType<typeof getDb>;
}

for (const driver of ["sqljs", "native"] as const) {
  describe(`human task metadata persistence (${driver})`, () => {
    let directory: string | undefined;
    beforeEach(async () => {
      if (driver === "sqljs") await initTestDb();
      else {
        directory = mkdtempSync(join(tmpdir(), "orcy-metadata-persistence-"));
        await initDb(join(directory, "test.sqlite"));
      }
    }, 120_000);
    afterEach(() => {
      closeDb();
      if (directory) rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    });

    // GROUND: PRD E6/E7 + DESIGN §5 — one write changes exactly the submitted fields plus bookkeeping, once, and exactly one human `updated` event (changedFields = actual changes) commits with it.
    it("changes exactly the submitted fields and bookkeeping, once, with one human updated event", () => {
      const f = setup();
      const before = taskRow(f.taskId);
      const result = save(f, { title: "Edited", description: "new body", priority: "high", expectedPriority: "medium" });
      expect(result).toMatchObject({ ok: true, changed: true, habitatId: f.habitatId });
      expect(result.ok).toBe(true);
      const after = taskRow(f.taskId);
      if (result.ok) expect(result.task).toEqual(after);
      expect(after).toEqual({ ...before, title: "Edited", description: "new body", priority: "high", updatedAt: after.updatedAt, version: before.version + 1 });
      expect(after.updatedAt).not.toBe(before.updatedAt);
      const events = updatedEvents(f.taskId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: "human", actorId: f.owner, fromStatus: "pending", toStatus: "pending" });
      expect(events[0].metadata).toMatchObject({ changedFields: ["title", "description", "priority"] });
    });

    // GROUND: PRD E6 (unchanged request is a no-op success with zero writes/events) + DESIGN §5 all-equal paragraph — full row equality, no timestamp change.
    it("treats an unchanged request as a no-op success with zero writes and zero events", () => {
      const f = setup();
      const before = taskRow(f.taskId);
      const eventsBefore = allEvents(f.taskId);
      const result = save(f, { title: "Task", description: "body", priority: "medium", expectedPriority: "medium" });
      expect(result).toMatchObject({ ok: true, changed: false });
      expect(taskRow(f.taskId)).toEqual(before);
      expect(allEvents(f.taskId)).toEqual(eventsBefore);
    });

    // GROUND: DESIGN §5 — "no row ... after successful prechecks is an infrastructure failure ... never a silent no-op". A trigger-forced RAISE(IGNORE) reddens exactly that, and the reservation is released for the next writer.
    it("fails as infrastructure when a trigger ignores the tasks update, then releases the reservation", () => {
      const f = setup();
      const before = taskRow(f.taskId);
      getDb().run(sql`CREATE TRIGGER metadata_update_ignore BEFORE UPDATE ON tasks BEGIN SELECT RAISE(IGNORE); END`);
      expect(() => save(f, { title: "Edited" })).toThrow("no row after successful prechecks");
      expect(taskRow(f.taskId)).toEqual(before);
      expect(updatedEvents(f.taskId)).toHaveLength(0);
      getDb().run(sql`DROP TRIGGER metadata_update_ignore`);
      expect(save(f, { title: "Edited" })).toMatchObject({ ok: true, changed: true });
    });

    // GROUND: PRD E6 rollback clause + DESIGN §5 — RAISE(ABORT) on the tasks update keeps the same guarantees as IGNORE: infrastructure failure, complete preimage, no event, reservation released.
    it("rolls back to the complete preimage when a trigger aborts the tasks update, then releases the reservation", () => {
      const f = setup();
      const before = taskRow(f.taskId);
      getDb().run(sql`CREATE TRIGGER metadata_update_abort BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'metadata abort veto'); END`);
      let failure: unknown;
      try {
        save(f, { title: "Edited" });
      } catch (error) {
        failure = error;
      }
      expectCause(failure, "metadata abort veto");
      expect(taskRow(f.taskId)).toEqual(before);
      expect(updatedEvents(f.taskId)).toHaveLength(0);
      getDb().run(sql`DROP TRIGGER metadata_update_abort`);
      expect(save(f, { title: "Edited" })).toMatchObject({ ok: true, changed: true });
    });

    // GROUND: DESIGN §5 postimage paragraph ("stored postimage must equal the reserved preimage plus the allowed diff") — a trigger corrupting an unrelated column after the update rolls the whole reservation back to the complete preimage.
    it("rolls back unrelated-column postimage corruption to the complete preimage", () => {
      const f = setup();
      const before = taskRow(f.taskId);
      getDb().run(sql`CREATE TRIGGER metadata_corrupt_postimage AFTER UPDATE OF title ON tasks WHEN NEW.title = 'Edited' BEGIN UPDATE tasks SET status = 'claimed' WHERE id = NEW.id; END`);
      expect(() => save(f, { title: "Edited" })).toThrow("postimage mismatch");
      expect(taskRow(f.taskId)).toEqual(before);
      expect(updatedEvents(f.taskId)).toHaveLength(0);
      getDb().run(sql`DROP TRIGGER metadata_corrupt_postimage`);
      expect(save(f, { title: "Edited" })).toMatchObject({ ok: true, changed: true });
    });

    // GROUND: PRD E6 ("exactly one updated event commits with the row") — aborting the event insert rolls the task write back with it: atomicity, not best-effort events.
    it("rolls the task row back when the event insert aborts, then releases the reservation", () => {
      const f = setup();
      const before = taskRow(f.taskId);
      const eventsBefore = allEvents(f.taskId);
      getDb().run(sql`CREATE TRIGGER metadata_event_abort BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'metadata event veto'); END`);
      let failure: unknown;
      try {
        save(f, { title: "No event" });
      } catch (error) {
        failure = error;
      }
      expectCause(failure, "metadata event veto");
      expect(taskRow(f.taskId)).toEqual(before);
      expect(allEvents(f.taskId)).toEqual(eventsBefore);
      getDb().run(sql`DROP TRIGGER metadata_event_abort`);
      expect(save(f, { title: "Edited" })).toMatchObject({ ok: true, changed: true });
    });

    // GROUND: DESIGN §5 expectedPriority fence — the write below is applyAction's set_priority shape (prioritizationService.ts:301): priority+updatedAt, no version bump. A stale priority edit is refused while versions still match; a title-only save from that same version succeeds and retains the raced priority.
    it("refuses a stale priority edit at a still-current version, then accepts a title-only save retaining the new priority", () => {
      const f = setup();
      const version = baseline(f).expectedVersion;
      getDb().update(tasks).set({ priority: "critical", updatedAt: new Date().toISOString() }).where(eq(tasks.id, f.taskId)).run();
      const afterRaw = taskRow(f.taskId);
      expect(afterRaw.version).toBe(version); // the fenced writer does not bump version
      const stale = save(f, { priority: "high", expectedPriority: "medium" });
      expect(stale).toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
      expect(taskRow(f.taskId)).toEqual(afterRaw); // full row unchanged by the refusal
      expect(save(f, { title: "Title only" })).toMatchObject({ ok: true, changed: true });
      const saved = taskRow(f.taskId);
      expect(saved).toEqual({ ...afterRaw, title: "Title only", updatedAt: saved.updatedAt, version: afterRaw.version + 1 });
      expect(saved.priority).toBe("critical");
    });

    // GROUND: PRD E7 (post-commit notification failure is logged, never fatal) — the commit stands with its row and event.
    it("keeps the committed row and event when the post-commit emitter fails", () => {
      const f = setup();
      const spy = vi.spyOn(transitionEmitter, "emitTransition").mockImplementation(() => {
        throw new Error("postlude boom");
      });
      try {
        const before = taskRow(f.taskId);
        const result = save(f, { title: "Postlude" });
        expect(result).toMatchObject({ ok: true, changed: true });
        const after = taskRow(f.taskId);
        expect(after).toEqual({ ...before, title: "Postlude", updatedAt: after.updatedAt, version: before.version + 1 });
        expect(updatedEvents(f.taskId)).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    // GROUND: schema iff-rule mirrored in the core — a direct caller supplying
    // expectedPriority without priority throws before any reservation is taken.
    it("throws for a direct caller supplying expectedPriority without priority", () => {
      const f = setup();
      const before = taskRow(f.taskId);
      expect(() => save(f, { title: "Stray", expectedPriority: "medium" })).toThrow("expectedPriority requires priority");
      expect(taskRow(f.taskId)).toEqual(before);
      expect(updatedEvents(f.taskId)).toHaveLength(0);
    });

    // GROUND: PRD E6 (recognized native busy/lock acquisition failures map to CONTENTION) + DESIGN §4 last paragraph — direct messages, cause-wrapped errors, and native `code` values with unrelated messages all classify at acquisition.
    it.each([
      ["direct message", () => new Error("database is locked")],
      ["cause-wrapped", () => new Error("writer could not begin", { cause: new Error("database table is locked") })],
      ["native code with unrelated message", () => Object.assign(new Error("totally unrelated"), { code: "SQLITE_BUSY" })],
    ] as const)("maps %s at acquisition to CONTENTION without touching the row", (_name, make) => {
      const f = setup();
      const before = taskRow(f.taskId);
      const result = saveTaskMetadataWithClient(clientFailingOnNthRun(1, make), {
        taskId: f.taskId,
        userId: f.owner,
        ...baseline(f),
        title: "Never",
      });
      expect(result).toMatchObject({ ok: false, code: "CONTENTION" });
      expect(taskRow(f.taskId)).toEqual(before);
      expect(updatedEvents(f.taskId)).toHaveLength(0);
    });

    // GROUND: PRD E6 (any failure rolls back with no partial state) + DESIGN §4 — busy recognition is acquisition-only: the identical error at commit time rolls the staged row+event back, propagates as an infrastructure failure, and leaves the reservation released.
    it("rolls back and propagates an identical busy error injected after acquisition", () => {
      const f = setup();
      const before = taskRow(f.taskId);
      const eventsBefore = allEvents(f.taskId);
      const client = clientFailingOnNthRun(2, () => Object.assign(new Error("commit path unrelated"), { code: "SQLITE_BUSY" }));
      let failure: unknown;
      try {
        saveTaskMetadataWithClient(client, { taskId: f.taskId, userId: f.owner, ...baseline(f), title: "Rolled back" });
      } catch (error) {
        failure = error;
      }
      expectCause(failure, "commit path unrelated");
      expect(taskRow(f.taskId)).toEqual(before); // staged update+event undone by the rollback
      expect(allEvents(f.taskId)).toEqual(eventsBefore);
      expect(save(f, { title: "After rollback" })).toMatchObject({ ok: true, changed: true }); // reservation released
    });
  });
}
