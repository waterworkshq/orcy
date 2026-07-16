import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  missions,
  pulses,
  releases as releasesTable,
  notificationEvents,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(notificationEvents).run();
  db.delete(pulses).run();
  db.delete(missions).run();

  const habitat = habitatRepo.createHabitat({ name: "Deadline Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => closeDb());

function seedDeadlineMission(opts: {
  title: string;
  releaseDeadlineType: "patch" | "minor" | "major";
  releaseDeadlineVersion?: string;
  status?: "not_started" | "in_progress" | "done";
}) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: opts.title,
    createdBy: "user-1",
    releaseDeadlineType: opts.releaseDeadlineType,
    releaseDeadlineVersion: opts.releaseDeadlineVersion,
  });
  if (opts.status && opts.status !== "not_started") {
    // Transition to the desired status via the repo (done missions need completion).
    missionRepo.updateMission(mission.id, { status: opts.status });
  }
  return mission;
}

function deadlineMissedNotifications(): Array<Record<string, unknown>> {
  return getDb()
    .select()
    .from(notificationEvents)
    .where(eq(notificationEvents.eventType, "release.deadline_missed"))
    .all();
}

function retrospectiveFor(version: string) {
  return getDb()
    .select()
    .from(pulses)
    .where(eq(pulses.habitatId, habitatId))
    .all()
    .filter((p) => {
      const meta = p.metadata as Record<string, unknown> | null;
      return meta?.releaseRetrospective === true && meta.version === version;
    });
}

describe("RM-1: release-deadline escalation on miss", () => {
  it("escalates when a deadline-matched mission is NOT done on release ship", async () => {
    const m = seedDeadlineMission({ title: "overdue", releaseDeadlineType: "minor" });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    expect(result.missedDeadlineCount).toBe(1);
    expect(deadlineMissedNotifications()).toHaveLength(1);
    // Retrospective records the normalized version (no 'v' prefix).
    const retro = retrospectiveFor("0.1.0");
    expect(retro[0]?.body).toContain("Deadlines missed");
    // The mission is NOT blocked from claiming — escalation is a signal, not a hard stop.
    expect(missionRepo.getMissionById(m.id)!.status).toBe("not_started");
  });

  it("does NOT escalate when the deadline-matched mission IS done", async () => {
    seedDeadlineMission({ title: "done-in-time", releaseDeadlineType: "minor", status: "done" });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    expect(result.missedDeadlineCount).toBe(0);
    expect(deadlineMissedNotifications()).toHaveLength(0);
  });

  it("does NOT escalate when the shipped release does not match the deadline type", async () => {
    // major deadline, patch shipped — patch does not cascade-up to major
    seedDeadlineMission({ title: "major-deadline", releaseDeadlineType: "major" });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "patch",
      detectedBy: "api",
    });

    expect(result.missedDeadlineCount).toBe(0);
    expect(deadlineMissedNotifications()).toHaveLength(0);
  });

  it("matches the deadline via version-pin (exact + prefix)", async () => {
    seedDeadlineMission({
      title: "pinned",
      releaseDeadlineType: "minor",
      releaseDeadlineVersion: "v0.25",
    });

    // prefix match: v0.25.x (releaseType explicit — version-pin arm matches regardless of type)
    const r1 = await releaseTriggerService.detectAndActivate(habitatId, "v0.25.3", {
      releaseType: "patch",
      detectedBy: "api",
    });
    expect(r1.missedDeadlineCount).toBe(1);
  });
});

describe("RM-2: compound release window (after-gate + before-deadline compose)", () => {
  it("after-gate claim-blocks until its release ships; before-deadline escalates on its own miss", async () => {
    // Mission valid in the v0.25 → v0.26 window: gated-after v0.25, due-before v0.26.
    const m = missionRepo.createMission({
      habitatId,
      columnId,
      title: "windowed",
      createdBy: "user-1",
      releaseGateType: "minor", // after-gate: claim-blocked until a minor ships
      releaseDeadlineType: "major", // before-deadline: escalate if not done when a major ships
    });

    // First release (minor): resolves the after-gate. No major shipped yet → no deadline miss.
    const r1 = await releaseTriggerService.detectAndActivate(habitatId, "v0.25.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    expect(r1.missedDeadlineCount).toBe(0);
    expect(deadlineMissedNotifications()).toHaveLength(0);

    // Second release (major): matches the major deadline. Mission still not_started → escalate.
    const r2 = await releaseTriggerService.detectAndActivate(habitatId, "v0.26.0", {
      releaseType: "major",
      detectedBy: "api",
    });
    expect(r2.missedDeadlineCount).toBe(1);
    expect(deadlineMissedNotifications()).toHaveLength(1);
    // The two mechanisms are independent: the mission was never hard-locked by the deadline.
    expect(missionRepo.getMissionById(m.id)!.status).toBe("not_started");
  });
});
