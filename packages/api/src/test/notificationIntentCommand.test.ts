import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { initTestDb, initDb, closeDb, getDb } from "../db/index.js";
import {
  habitats,
  notificationDeliveries,
  notificationEvents,
  organizations,
  taskReviewers,
  tasks,
  taskEvents,
  remoteParticipants,
  teamMembers,
  teams,
  users,
} from "../db/schema/index.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as reviewerRepo from "../repositories/taskReviewer.js";
import * as agentRepo from "../repositories/agent.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { findRemoteRecipientsForEvent } from "../services/remoteNotificationResolver.js";
import { generateDailyDigests } from "../services/notificationDigestService.js";
import {
  enqueueNotificationWithIntents,
  resolveAudience,
  NotificationIntentError,
  type NotificationAudienceIntent,
} from "../services/notificationIntentCommand.js";

/* ---------- failure-injection mocks (full surface mirrored via spread) ---------- */
/* vi.hoisted: vi.mock factories are hoisted ABOVE this module's top-level
 * declarations and run at mocked-module import time; shared mutable state
 * MUST come from vi.hoisted so it is initialized before any factory closure
 * can observe it. The factories below only READ this state inside the
 * wrapped functions (invoked at test runtime, after module init) — vi.hoisted
 * removes even that ordering assumption. */

const inject = vi.hoisted(() => ({ event: false, deliveryOnCall: 0, deliveryCalls: 0 }));
const resetInject = () => {
  inject.event = false;
  inject.deliveryOnCall = 0;
  inject.deliveryCalls = 0;
};

vi.mock("../repositories/notificationEvent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/notificationEvent.js")>();
  return {
    ...actual,
    createNotificationEvent: vi.fn(
      (input: Parameters<typeof actual.createNotificationEvent>[0]) => {
        if (inject.event) throw new Error("INJECTED_EVENT_FAILURE");
        return actual.createNotificationEvent(input);
      },
    ),
  };
});

vi.mock("../repositories/notificationDelivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/notificationDelivery.js")>();
  return {
    ...actual,
    createNotificationDelivery: vi.fn(
      (input: Parameters<typeof actual.createNotificationDelivery>[0]) => {
        inject.deliveryCalls += 1;
        if (inject.deliveryOnCall === inject.deliveryCalls) {
          throw new Error("INJECTED_DELIVERY_FAILURE");
        }
        return actual.createNotificationDelivery(input);
      },
    ),
  };
});

/* ---------- fixtures (grounded on existing suites; fresh DB per test) ---------- */

let seq = 0;
const uid = (p: string) => `${p}-${++seq}-${randomUUID().slice(0, 8)}`;
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const eventCount = () => getDb().select({ n: sql<number>`count(*)` }).from(notificationEvents).get()?.n ?? 0;
const deliveryCount = () => getDb().select({ n: sql<number>`count(*)` }).from(notificationDeliveries).get()?.n ?? 0;

function insertUser(id: string, role: "admin" | "editor" | "viewer" = "editor") {
  getDb().insert(users).values({ id, username: uid(`u-${id}`), passwordHash: "hash", displayName: id, role }).run();
}

function setupTeamHabitat(
  members: Array<{ userId: string; role: "owner" | "admin" | "member"; userRole?: "admin" | "editor" | "viewer" }>,
) {
  const db = getDb();
  const orgId = uid("org");
  const teamId = uid("team");
  const habitatId = uid("hab");
  db.insert(organizations).values({ id: orgId, name: "Org", slug: uid("org") }).run();
  db.insert(teams).values({ id: teamId, organizationId: orgId, name: "Team", slug: uid("team") }).run();
  for (const m of members) {
    insertUser(m.userId, m.userRole ?? "editor");
    db.insert(teamMembers).values({ id: uid("tm"), teamId, userId: m.userId, role: m.role }).run();
  }
  db.insert(habitats).values({ id: habitatId, name: "Team Habitat", teamId }).run();
  return habitatId;
}

function setupPersonalHabitat(ownerUserId?: string) {
  const habitatId = uid("hab");
  if (ownerUserId) insertUser(ownerUserId);
  getDb().insert(habitats).values({ id: habitatId, name: "Personal Habitat", ownerUserId: ownerUserId ?? null }).run();
  return habitatId;
}

function insertAgent(name: string) {
  return agentRepo.createAgent({ name: uid(name), type: "claude-code", domain: "backend", capabilities: [] }).agent;
}

function seedTask(habitatId: string) {
  columnRepo.createColumn({ habitatId, name: uid("col") });
  const mission = missionRepo.createMission({ habitatId, title: "M", priority: "medium", createdBy: "test" });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "T",
    description: "x",
    requiredCapabilities: [],
    labels: [],
    createdBy: "test",
  });
  return { mission, task };
}

function seedTaskEvent(
  taskId: string,
  actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod",
  actorId: string,
  action: "created" | "cloned" = "created",
  ts = "2026-01-01T00:00:00.000Z",
) {
  getDb().insert(taskEvents).values({ id: uid("te"), taskId, actorType, actorId, action, timestamp: ts, metadata: {} }).run();
}

/** Grounded on remoteNotificationResolver.test.ts:41-160 (scoped_elevation/allowlist task grant). */
function seedRemoteParticipantVisibleOnTask(
  habitatId: string,
  taskId: string,
  participantType: "remote_human" | "remote_orcy" = "remote_orcy",
) {
  const pod = podRepo.activateRemotePod(podRepo.createRemotePod({ habitatId, name: uid("pod") }).id)!;
  const p = participantRepo.activateRemoteParticipant(
    participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId,
      participantType,
      displayName: "Remote",
      standing: "remote_contributor",
    }).id,
  )!;
  const grant = grantRepo.createRemoteGrant({
    habitatId,
    remotePodId: pod.id,
    remoteParticipantId: p.id,
    grantType: "scoped_elevation",
    standing: "remote_contributor",
    actionScopes: ["read"],
    eligibilityMode: "allowlist",
  });
  grantRepo.addRemoteGrantTarget(grant.id, "task", taskId);
  return p;
}

function defaultSub(habitatId: string, eventType = "task.blocked", overrides?: Partial<subscriptionRepo.CreateSubscriptionInput>) {
  return subscriptionRepo.createSubscription({
    habitatId,
    scope: "habitat_default",
    eventType,
    enabled: true,
    required: false,
    channels: ["in_app"],
    cadence: "immediate",
    ...overrides,
  });
}

function overrideSub(
  habitatId: string,
  recipientType: "human" | "agent",
  recipientId: string,
  eventType = "task.blocked",
  overrides?: Partial<subscriptionRepo.CreateSubscriptionInput>,
) {
  return subscriptionRepo.createSubscription({
    habitatId,
    scope: "recipient_override",
    recipientType,
    recipientId,
    eventType,
    enabled: true,
    channels: ["in_app", "webhook"],
    cadence: "immediate",
    ...overrides,
  });
}

function enqueue(
  habitatId: string,
  intents: NotificationAudienceIntent[],
  scope?: { outer: "reserved-immediate" },
) {
  return enqueueNotificationWithIntents(
    {
      habitatId,
      eventType: "task.blocked",
      sourceType: "task",
      severity: "warning",
      createdByType: "system",
      intents,
    },
    scope,
  );
}

function expectIntentError(fn: () => unknown, code: string) {
  let thrown: unknown;
  try { fn(); } catch (err) { thrown = err; }
  expect(thrown).toBeInstanceOf(NotificationIntentError);
  expect((thrown as NotificationIntentError).code).toBe(code);
}

beforeEach(() => {
  resetInject();
});

/* ---------- T2: exact intent (N1) ---------- */

describe("intent core — exact (N1)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // GROUND: TASKS T2 (N1 exact audience); DESIGN §3 `exact` row; PRD N1 — named eligible human admitted.
  it("admits a current team member human", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    const out = resolveAudience({
      habitatId,
      eventType: "task.blocked",
      intents: [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }],
    });
    expect(out.candidates).toEqual([{ recipientType: "human", recipientId: "member-1" }]);
  });

  // GROUND: DESIGN §3 `exact` row ("Existing identity and applicable Habitat admission are required"); PRD N1.
  it("rejects a non-member human on a team habitat (INVALID_EXACT_RECIPIENT)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    insertUser("outsider-1");
    expectIntentError(
      () =>
        resolveAudience({
          habitatId,
          eventType: "task.blocked",
          intents: [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "outsider-1" }] }],
        }),
      "INVALID_EXACT_RECIPIENT",
    );
  });

  // GROUND: DESIGN §6 (invalid/unsupported input fails with zero writes); PRD N1.
  it("rejects an unknown agent id (INVALID_EXACT_RECIPIENT)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    expectIntentError(
      () =>
        resolveAudience({
          habitatId,
          eventType: "task.blocked",
          intents: [{ kind: "exact", recipients: [{ recipientType: "agent", recipientId: "no-such-agent" }] }],
        }),
      "INVALID_EXACT_RECIPIENT",
    );
  });

  // GROUND: DESIGN §3 `exact` row ("preserving deliberately broad local-agent access"); PRD N1.
  it("admits a known agent with no habitat-affiliation filter (deliberately broad agent admission)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    const agent = insertAgent("worker");
    const out = resolveAudience({
      habitatId,
      eventType: "task.blocked",
      intents: [{ kind: "exact", recipients: [{ recipientType: "agent", recipientId: agent.id }] }],
    });
    expect(out.candidates).toEqual([{ recipientType: "agent", recipientId: agent.id }]);
  });

  // GROUND: DESIGN §3 `exact` row ("No remote augmentation"); PRD N1 (typed identity, never an id-string guess).
  it("rejects remote refs in exact (INVALID_EXACT_RECIPIENT)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    expectIntentError(
      () =>
        resolveAudience({
          habitatId,
          eventType: "task.blocked",
          intents: [{ kind: "exact", recipients: [{ recipientType: "remote_human", recipientId: "rp-1" }] as never }],
        }),
      "INVALID_EXACT_RECIPIENT",
    );
  });
});

/* ---------- T2: habitat_members / habitat_operators (N2) ---------- */

describe("intent core — habitat_members (N2)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // GROUND: DESIGN §3 `habitat_members` row; PRD §4 "Member intent may include current readable viewer members".
  it("team ⇒ all current members, any team role, incl. a global-viewer-role user", () => {
    const habitatId = setupTeamHabitat([
      { userId: "owner-1", role: "owner" },
      { userId: "member-1", role: "member" },
      { userId: "viewer-1", role: "member", userRole: "viewer" },
    ]);
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "habitat_members" }] });
    expect(out.candidates.map((c) => c.recipientId).toSorted()).toEqual(["member-1", "owner-1", "viewer-1"]);
  });

  // GROUND: DESIGN §3 `habitat_members` row ("personal owner if explicitly set"); PRD §4 (owned personal Habitats have an actual owner relation).
  it("personal owned ⇒ the owner only", () => {
    const habitatId = setupPersonalHabitat("owner-9");
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "habitat_members" }] });
    expect(out.candidates).toEqual([{ recipientType: "human", recipientId: "owner-9" }]);
  });

  // GROUND: DESIGN §3 `habitat_members` row ("otherwise empty"); PRD §4 (unowned must not receive an inferred owner) + N7 classified empty outcome.
  it("personal unowned ⇒ empty, classified no_recipients (never a fabricated population)", () => {
    const habitatId = setupPersonalHabitat();
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "habitat_members" }] });
    expect(out.candidates).toEqual([]);
    expect(out.emptyReason).toBe("no_recipients");
    const r = enqueue(habitatId, [{ kind: "habitat_members" }]);
    expect(r.outcome).toBe("event_only");
    expect(r.emptyReasons).toEqual(["no_recipients"]);
    expect(eventCount()).toBe(1); // the legitimate-empty Event IS committed (N7)
  });

  // GROUND: DESIGN §3 (unresolved context refuses); TASKS T2 Coverage N3/N7 — missing target is not a fabricated population.
  it("missing habitat ⇒ MISSING_CONTEXT_TARGET", () => {
    expectIntentError(
      () => resolveAudience({ habitatId: "no-such-habitat", eventType: "task.blocked", intents: [{ kind: "habitat_members" }] }),
      "MISSING_CONTEXT_TARGET",
    );
  });
});

describe("intent core — habitat_operators (N2)", () => {
  beforeEach(async () => {
    await initTestDb();
    getDb().delete(users).where(eq(users.username, "admin")).run();
  });
  afterEach(() => closeDb());

  // GROUND: DESIGN §3 `habitat_operators` row; PRD N2 ("Do not notify all global administrators when scoped responsible operators exist").
  it("team ⇒ owner/admin team roles with users.role ≠ viewer; plain members excluded; no global admins added", () => {
    insertUser("global-admin-1", "admin"); // NOT a team member
    const habitatId = setupTeamHabitat([
      { userId: "owner-1", role: "owner" },
      { userId: "admin-1", role: "admin" },
      { userId: "plain-1", role: "member" },
    ]);
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "habitat_operators" }] });
    expect(out.candidates.map((c) => c.recipientId).toSorted()).toEqual(["admin-1", "owner-1"]);
  });

  // GROUND: DESIGN §3 `habitat_operators` row ("non-viewer"); PRD §4 (operator intent excludes the global-viewer authority ceiling).
  it("team admin whose users.role is viewer is excluded (viewer ceiling)", () => {
    const habitatId = setupTeamHabitat([
      { userId: "owner-1", role: "owner" },
      { userId: "viewer-admin-1", role: "admin", userRole: "viewer" },
    ]);
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "habitat_operators" }] });
    expect(out.candidates.map((c) => c.recipientId)).toEqual(["owner-1"]);
  });

  // GROUND: DESIGN §3 `habitat_operators` row ("If no scoped responsible humans exist, global-admin fallback") + CORE-TASKS §1 correction 3.
  it("empty scoped set ⇒ global-admin fallback, WITHOUT exact-membership revalidation", () => {
    insertUser("global-admin-1", "admin"); // non-member by construction
    const habitatId = setupTeamHabitat([{ userId: "plain-1", role: "member" }]); // no owner/admin rows
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "habitat_operators" }] });
    expect(out.candidates).toEqual([{ recipientType: "human", recipientId: "global-admin-1" }]);
  });

  // GROUND: DESIGN §3 `habitat_operators` row + §4 "Legacy unowned personal operation gets the explicit global-admin fallback"; PRD §4.
  it("personal owned by a viewer-role owner ⇒ unserved ⇒ global-admin fallback", () => {
    insertUser("global-admin-1", "admin");
    const habitatId = setupPersonalHabitat("viewer-owner-1");
    getDb().update(users).set({ role: "viewer" }).where(eq(users.id, "viewer-owner-1")).run();
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "habitat_operators" }] });
    expect(out.candidates).toEqual([{ recipientType: "human", recipientId: "global-admin-1" }]);
  });

  // GROUND: PRD §4 (unowned personal operator attention falls back to global admins, never an invented member population).
  it("unowned personal ⇒ global-admin fallback", () => {
    insertUser("global-admin-1", "admin");
    const habitatId = setupPersonalHabitat();
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "habitat_operators" }] });
    expect(out.candidates).toEqual([{ recipientType: "human", recipientId: "global-admin-1" }]);
  });
});

/* ---------- T3: required-precedence policy matrix (N5) ---------- */

describe("intent core — required precedence (N5)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  const REQUIRED_DEFAULT = { channels: ["in_app", "email"] as const, cadence: "immediate" as const };
  const requiredDelivery = (r: ReturnType<typeof enqueue>) => {
    expect(r.deliveries).toHaveLength(1);
    expect(r.deliveries[0].required).toBe(true);
    expect(r.deliveries[0].channels).toEqual(["in_app", "email"]);
    expect(r.suppressed).toEqual([]);
  };

  // GROUND: TASKS T3 bullet 1 (disabled vs required default); DESIGN §4 (personal disable cannot remove the required path); PRD N5.
  it("disabled override + required default ⇒ required default wins (was suppressed — T1 pinned)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId, "task.blocked", { required: true, channels: ["in_app", "email"] });
    overrideSub(habitatId, "human", "member-1", "task.blocked", { enabled: false });
    requiredDelivery(enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]));
  });

  // GROUND: TASKS T3 bullet 1 (muted vs required default); DESIGN §4; PRD N5.
  it("muted override + required default ⇒ required default wins", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId, "task.blocked", { required: true, channels: ["in_app", "email"] });
    overrideSub(habitatId, "human", "member-1", "task.blocked", { muteUntil: future() });
    requiredDelivery(enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]));
  });

  // GROUND: TASKS T3 bullet 1 (empty channels vs required default); DESIGN §4; PRD N5.
  it("empty-channels override + required default ⇒ the default's channels carry the mandatory path", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId, "task.blocked", { required: true, channels: ["in_app", "email"] });
    overrideSub(habitatId, "human", "member-1", "task.blocked", { channels: [] });
    requiredDelivery(enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]));
  });

  // GROUND: CORE-TASKS §1 correction 2 (required beats EVERY override incl. enabled+nonempty); DESIGN §4; PRD N5.
  it("ENABLED NONEMPTY override + required default ⇒ the required default's channels/cadence still win (alternate channels cannot drop the mandatory path)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId, "task.blocked", { required: true, channels: ["in_app", "email"], cadence: "immediate" });
    overrideSub(habitatId, "human", "member-1", "task.blocked", { channels: ["slack"], cadence: "daily" });
    requiredDelivery(enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]));
  });

  // GROUND: DESIGN §4 ("If a mandatory default exists, its configured channels and cadence carry the required path"); PRD N5.
  it("no override + required default ⇒ required", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId, "task.blocked", { required: true, channels: ["in_app", "email"] });
    requiredDelivery(enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]));
  });

  // GROUND: DESIGN §4 owner decision (cadence end-to-end, CORE-TASKS §1 correction 12 / §2b); PRD N5 ("required cadence must govern downstream delivery/digest scheduling").
  it("required DIGEST cadence is persisted end-to-end and drives digest grouping (N5, §2b)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId, "task.blocked", { required: true, channels: ["in_app"], cadence: "daily" });
    overrideSub(habitatId, "human", "member-1", "task.blocked", { cadence: "immediate" }); // personal immediate must NOT override the mandatory cadence
    const r = enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]);
    expect(r.deliveries).toHaveLength(1);
    expect(r.deliveries[0]!.required).toBe(true);
    expect(r.deliveries[0]!.cadence).toBe("daily"); // the REQUIRED default's cadence, not the override's "immediate"
    // End-to-end digest scheduling: the recipient has NO daily subscription row —
    // only the persisted delivery cadence (§2b) puts them in the daily group.
    // Group membership is the scheduling authority; the wall-clock firing gate
    // (shouldProcessAtThisTime) is independent of this assertion.
    const digests = generateDailyDigests();
    expect(digests.some((d) => d.habitatId === habitatId && d.recipientId === "member-1")).toBe(true);
  });

  // GROUND: DESIGN §4; PRD N5 — immediate required cadence is persisted and never digest-scheduled.
  it("required IMMEDIATE default persists cadence immediate and never joins a digest group", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId, "task.blocked", { required: true, channels: ["in_app"], cadence: "immediate" });
    const r = enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]);
    expect(r.deliveries[0]!.cadence).toBe("immediate");
    expect(generateDailyDigests().some((d) => d.habitatId === habitatId && d.recipientId === "member-1")).toBe(false);
  });

  // GROUND: DESIGN §4 ("Without required default, preserve current enabled/mute/cadence/no-default preference behavior"); PRD N5.
  it("disabled override + NO required default ⇒ suppressed disabled (current behavior preserved)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId);
    overrideSub(habitatId, "human", "member-1", "task.blocked", { enabled: false });
    const r = enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]);
    expect(r.deliveries).toHaveLength(0);
    expect(r.suppressed).toEqual([{ recipientType: "human", recipientId: "member-1", reason: "disabled" }]);
    expect(r.emptyReasons).toEqual(["all_suppressed"]);
  });

  // GROUND: DESIGN §4 (preserve current mute behavior absent a required default); PRD N7 (classified preference suppression).
  it("muted override + NO required default ⇒ suppressed muted (current)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId);
    overrideSub(habitatId, "human", "member-1", "task.blocked", { muteUntil: future() });
    const r = enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]);
    expect(r.deliveries).toHaveLength(0);
    expect(r.suppressed[0].reason).toBe("muted");
  });

  // GROUND: DESIGN §4 (preserve no-default behavior); PRD N7.
  it("no override + no default ⇒ suppressed no_default (current)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    const r = enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]);
    expect(r.suppressed[0].reason).toBe("no_default");
  });

  // GROUND: DESIGN §4 ("Channel selection is transport policy, not recipient identity" — override wins absent a required default); PRD N5.
  it("enabled nonempty override + plain default ⇒ the override's channels win (current behavior preserved)", () => {
    const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
    defaultSub(habitatId, "task.blocked", { channels: ["in_app"], cadence: "daily" });
    overrideSub(habitatId, "human", "member-1", "task.blocked", { channels: ["slack"], cadence: "immediate" });
    const r = enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]);
    expect(r.deliveries[0].channels).toEqual(["slack"]);
    expect(r.deliveries[0].required).toBe(false);
  });
});

/* ---------- T5: task audiences + remote_visible (N3, N1-remote) ---------- */

describe("intent core — task_assignee (N3)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // GROUND: DESIGN §3 `task_assignee` row ("Resolve local/remote typed principal"); PRD N3.
  it("local agent assigned ⇒ agent candidate (exists-checked)", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const agent = insertAgent("assignee");
    getDb().update(tasks).set({ assignedAgentId: agent.id }).where(eq(tasks.id, task.id)).run();
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "task_assignee", taskId: task.id }] });
    expect(out.candidates).toEqual([{ recipientType: "agent", recipientId: agent.id }]);
  });

  // GROUND: DESIGN §3 `task_assignee` row + §3 named-remote section (effective target authority); PRD N3.
  it("remote participant assigned and effectively visible on the task ⇒ remote candidate with the participant's own type", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const p = seedRemoteParticipantVisibleOnTask(habitatId, task.id, "remote_human");
    getDb().update(tasks).set({ remoteAssignedParticipantId: p.id }).where(eq(tasks.id, task.id)).run();
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "task_assignee", taskId: task.id }] });
    expect(out.candidates).toEqual([{ recipientType: "remote_human", recipientId: p.id }]);
  });

  // GROUND: DESIGN §3 named-remote section + CORE-TASKS §1 correction 5 (explicit-uneligible creates no new attention, classified); PRD N3.
  it("remote participant assigned but NOT visible on the task ⇒ suppressedRemote ineligible_remote (no throw)", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const pod = podRepo.activateRemotePod(podRepo.createRemotePod({ habitatId, name: uid("pod") }).id)!;
    const p = participantRepo.activateRemoteParticipant(
      participantRepo.createRemoteParticipant({
        remotePodId: pod.id,
        habitatId,
        participantType: "remote_orcy",
        displayName: "Ungranted",
        standing: "remote_contributor",
      }).id,
    )!; // active participant, NO grant and NO target ⇒ invisible for this task
    getDb().update(tasks).set({ remoteAssignedParticipantId: p.id }).where(eq(tasks.id, task.id)).run();
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "task_assignee", taskId: task.id }] });
    expect(out.candidates).toEqual([]);
    expect(out.suppressedRemote).toEqual([{ recipientType: "remote_orcy", recipientId: p.id }]);
  });

  // GROUND: DESIGN §3 `task_assignee` row ("Both local+remote owner columns is an integrity refusal"); PRD N3.
  it("both assignedAgentId and remoteAssignedParticipantId ⇒ ASSIGNMENT_INTEGRITY refusal", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const agent = insertAgent("assignee");
    getDb().update(tasks).set({ assignedAgentId: agent.id, remoteAssignedParticipantId: "rp-x" }).where(eq(tasks.id, task.id)).run();
    expectIntentError(
      () => resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "task_assignee", taskId: task.id }] }),
      "ASSIGNMENT_INTEGRITY",
    );
  });

  // GROUND: DESIGN §3 `task_assignee` row ("no assignment is classified empty"); PRD N3 + N7.
  it("unassigned ⇒ emptyReason no_recipients (not an error)", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "task_assignee", taskId: task.id }] });
    expect(out.candidates).toEqual([]);
    expect(out.emptyReason).toBe("no_recipients");
  });

  // GROUND: DESIGN §3 ("A contextual task outside the command Habitat must fail before reads become recipient attention"); CORE-TASKS §1 correction 6; PRD N3.
  it("task in a DIFFERENT habitat ⇒ MISSING_CONTEXT_TARGET with zero writes and no cross-habitat task reads", () => {
    const habitatA = setupTeamHabitat([{ userId: "owner-a", role: "owner" }]);
    const habitatB = setupTeamHabitat([{ userId: "owner-b", role: "owner" }]);
    const { task } = seedTask(habitatB);
    expectIntentError(
      () => resolveAudience({ habitatId: habitatA, eventType: "task.blocked", intents: [{ kind: "task_assignee", taskId: task.id }] }),
      "MISSING_CONTEXT_TARGET",
    );
    const r = expectIntentError.bind(null, () => enqueue(habitatA, [{ kind: "task_assignee", taskId: task.id }]), "MISSING_CONTEXT_TARGET");
    r();
    expect(eventCount()).toBe(0);
    expect(deliveryCount()).toBe(0);
  });
});

describe("intent core — task_reviewers (N3, roster membership)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // GROUND: DESIGN §3 `task_reviewers` row ("Current persisted typed roster. Review decision status alone does not define roster membership"); PRD N3.
  it("ALL current roster rows are audience regardless of review status (approved + pending both present)", () => {
    const habitatId = setupTeamHabitat([
      { userId: "owner-1", role: "owner" },
      { userId: "rev-human", role: "member" },
    ]);
    const agent = insertAgent("rev-agent");
    const { task } = seedTask(habitatId);
    reviewerRepo.create(task.id, "human", "rev-human");
    reviewerRepo.create(task.id, "agent", agent.id);
    getDb().update(taskReviewers).set({ status: "approved", reviewedAt: new Date().toISOString() })
      .where(eq(taskReviewers.reviewerId, "rev-human")).run();
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "task_reviewers", taskId: task.id }] });
    expect(out.candidates.map((c) => `${c.recipientType}:${c.recipientId}`).toSorted()).toEqual([
      `agent:${agent.id}`,
      "human:rev-human",
    ]);
  });

  // GROUND: DESIGN §3 `task_reviewers` row ("validate live identities/access"); PRD N3.
  it("dangling roster entry (deleted user) ⇒ INVALID_EXACT_RECIPIENT (fail-closed integrity)", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    reviewerRepo.create(task.id, "human", "ghost-user"); // no users row
    expectIntentError(
      () => resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "task_reviewers", taskId: task.id }] }),
      "INVALID_EXACT_RECIPIENT",
    );
  });

  // GROUND: DESIGN §3 `task_reviewers` row; PRD N7 (supported empty audience is classified, not a failure).
  it("empty roster ⇒ no_recipients", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const out = resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "task_reviewers", taskId: task.id }] });
    expect(out.candidates).toEqual([]);
    expect(out.emptyReason).toBe("no_recipients");
  });

  // GROUND: CORE-TASKS §1 correction 6 (no cross-habitat task reads for any task-targeted intent); DESIGN §3; PRD N3.
  it("task in a different habitat ⇒ MISSING_CONTEXT_TARGET", () => {
    const habitatA = setupTeamHabitat([{ userId: "owner-a", role: "owner" }]);
    const habitatB = setupTeamHabitat([{ userId: "owner-b", role: "owner" }]);
    const { task } = seedTask(habitatB);
    expectIntentError(
      () => resolveAudience({ habitatId: habitatA, eventType: "task.blocked", intents: [{ kind: "task_reviewers", taskId: task.id }] }),
      "MISSING_CONTEXT_TARGET",
    );
  });
});

describe("intent core — task_creator (N3, durable provenance)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  const creatorOf = (habitatId: string, taskId: string) =>
    resolveAudience({ habitatId, eventType: "task.blocked", intents: [{ kind: "task_creator", taskId }] });

  // GROUND: DESIGN §3 `task_creator` row ("Durable typed initial created/cloned provenance"); PRD N3.
  it("single created event, human actor ⇒ human candidate (member-validated)", () => {
    const habitatId = setupTeamHabitat([{ userId: "creator-1", role: "member" }]);
    const { task } = seedTask(habitatId);
    seedTaskEvent(task.id, "human", "creator-1");
    expect(creatorOf(habitatId, task.id).candidates).toEqual([{ recipientType: "human", recipientId: "creator-1" }]);
  });

  // GROUND: DESIGN §3 `task_creator` row (created/cloned provenance); PRD N3.
  it("cloned event, agent actor ⇒ agent candidate", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const agent = insertAgent("creator-agent");
    const { task } = seedTask(habitatId);
    seedTaskEvent(task.id, "agent", agent.id, "cloned");
    expect(creatorOf(habitatId, task.id).candidates).toEqual([{ recipientType: "agent", recipientId: agent.id }]);
  });

  // GROUND: DESIGN §3 `task_creator` row ("System creator has no inbox; classify it"); PRD N3 + N7.
  it("system actor ⇒ emptyReason system_creator, no fabricated inbox", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    seedTaskEvent(task.id, "system", "system");
    const out = creatorOf(habitatId, task.id);
    expect(out.candidates).toEqual([]);
    expect(out.emptyReason).toBe("system_creator");
    const r = enqueue(habitatId, [{ kind: "task_creator", taskId: task.id }]);
    expect(r.outcome).toBe("event_only");
    expect(r.emptyReasons).toEqual(["system_creator"]);
  });

  // GROUND: DESIGN §3 `task_creator` row + named-remote section (typed actor + effective authority); PRD N3.
  it("remote_human actor visible on the task ⇒ candidate; invisible actor ⇒ suppressedRemote", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const p = seedRemoteParticipantVisibleOnTask(habitatId, task.id, "remote_human");
    seedTaskEvent(task.id, "remote_human", p.id);
    expect(creatorOf(habitatId, task.id).candidates).toEqual([{ recipientType: "remote_human", recipientId: p.id }]);

    const habitat2 = setupTeamHabitat([{ userId: "owner-2", role: "owner" }]);
    const { task: task2 } = seedTask(habitat2);
    seedTaskEvent(task2.id, "remote_human", "unlinked-participant");
    const out2 = creatorOf(habitat2, task2.id);
    expect(out2.candidates).toEqual([]);
    expect(out2.suppressedRemote).toEqual([{ recipientType: "remote_human", recipientId: "unlinked-participant" }]);
  });

  // GROUND: DESIGN §3 `task_creator` row ("Contradictory/missing/empty legacy actor is actionable ambiguity"); PRD N3.
  it("created + cloned with contradictory actors ⇒ UNRESOLVED_PROVENANCE", () => {
    const habitatId = setupTeamHabitat([{ userId: "creator-1", role: "member" }]);
    const { task } = seedTask(habitatId);
    seedTaskEvent(task.id, "human", "creator-1", "created", "2026-01-01T00:00:00.000Z");
    seedTaskEvent(task.id, "human", "creator-2", "cloned", "2026-01-02T00:00:00.000Z");
    expectIntentError(() => creatorOf(habitatId, task.id), "UNRESOLVED_PROVENANCE");
  });

  // GROUND: CORE-TASKS §1 correction 1 (task_events orders by `timestamp`); DESIGN §3 `task_creator` row; PRD N3.
  it("created + cloned with identical actor ⇒ resolved (ordering by task_events.timestamp)", () => {
    const habitatId = setupTeamHabitat([{ userId: "creator-1", role: "member" }]);
    const { task } = seedTask(habitatId);
    seedTaskEvent(task.id, "human", "creator-1", "created", "2026-01-01T00:00:00.000Z");
    seedTaskEvent(task.id, "human", "creator-1", "cloned", "2026-01-02T00:00:00.000Z");
    expect(creatorOf(habitatId, task.id).candidates).toEqual([{ recipientType: "human", recipientId: "creator-1" }]);
  });

  // GROUND: DESIGN §3 `task_creator` row ("missing ... is actionable ambiguity"); PRD N3.
  it("no initial event ⇒ UNRESOLVED_PROVENANCE; empty actorId ⇒ UNRESOLVED_PROVENANCE", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    expectIntentError(() => creatorOf(habitatId, task.id), "UNRESOLVED_PROVENANCE");
    seedTaskEvent(task.id, "human", "");
    expectIntentError(() => creatorOf(habitatId, task.id), "UNRESOLVED_PROVENANCE");
  });

  // GROUND: DESIGN §3 `task_creator` row ("Never guess human from Task.createdBy"); PRD N3.
  it("remote_pod actor ⇒ UNRESOLVED_PROVENANCE", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    seedTaskEvent(task.id, "remote_pod", "pod-1");
    expectIntentError(() => creatorOf(habitatId, task.id), "UNRESOLVED_PROVENANCE");
  });
});

describe("intent core — remote_visible (N1/P5)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // GROUND: DESIGN §3 `remote_visible` row ("Preserve the accepted remote lifecycle population"); PRD N8/N1.
  it("pool population equals the discovery helper's output on the named target", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const p1 = seedRemoteParticipantVisibleOnTask(habitatId, task.id, "remote_human");
    const out = resolveAudience({
      habitatId,
      eventType: "task.blocked",
      intents: [{ kind: "remote_visible", targetType: "task", targetId: task.id }],
    });
    const expected = findRemoteRecipientsForEvent({ habitatId, eventType: "task.blocked", targetType: "task", targetId: task.id });
    expect(out.candidates).toEqual(expected.map((r) => ({ recipientType: r.recipientType, recipientId: r.recipientId })));
    expect(out.candidates.map((c) => c.recipientId)).toContain(p1.id);
  });

  // GROUND: DESIGN §3 named-remote section ("membership of a raw participant ID in that discovery list is not a valid universal eligibility check"); CORE-TASKS §1 correction 4; PRD N3.
  it("a linked provider identity does not lend its grant to another pod or suspended participant", () => {
    const habitatId = setupPersonalHabitat();
    const { task } = seedTask(habitatId);
    const eligible = seedRemoteParticipantVisibleOnTask(habitatId, task.id);
    getDb().update(remoteParticipants).set({ externalIdentityId: "same-provider-person" })
      .where(eq(remoteParticipants.id, eligible.id)).run();
    const otherPod = podRepo.activateRemotePod(podRepo.createRemotePod({ habitatId, name: uid("other-pod") }).id)!;
    const alias = participantRepo.activateRemoteParticipant(participantRepo.createRemoteParticipant({
      habitatId, remotePodId: otherPod.id, participantType: "remote_orcy",
      displayName: "Ungrant alias", standing: "remote_contributor", externalIdentityId: "same-provider-person",
    }).id)!;
    const resolve = () => resolveAudience({ habitatId, eventType: "task.blocked", intents: [{
      kind: "remote_visible", targetType: "task", targetId: task.id,
      explicitRemote: [{ recipientType: "remote_orcy", recipientId: alias.id }],
    }] });
    expect(resolve().candidates.some((candidate) => candidate.recipientId === alias.id)).toBe(false);
    expect(resolve().suppressedRemote).toContainEqual({ recipientType: "remote_orcy", recipientId: alias.id });
    participantRepo.suspendRemoteParticipant(alias.id);
    expect(resolve().candidates.some((candidate) => candidate.recipientId === alias.id)).toBe(false);
  });

  // GROUND: CORE-TASKS §1 correction 5 (explicit-uneligible narrows, never blind-unions); DESIGN §3 named-remote section; PRD N3.
  it("explicitRemote NOT effectively visible ⇒ suppressed (no blind union), pool never shrinks", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const inPool = seedRemoteParticipantVisibleOnTask(habitatId, task.id, "remote_orcy");
    const out = resolveAudience({
      habitatId,
      eventType: "task.blocked",
      intents: [{ kind: "remote_visible", targetType: "task", targetId: task.id, explicitRemote: [{ recipientType: "remote_orcy", recipientId: "ungranted-actor" }] }],
    });
    expect(out.candidates.map((c) => c.recipientId)).toEqual([inPool.id]); // pool intact, actor dropped
    expect(out.suppressedRemote).toEqual([{ recipientType: "remote_orcy", recipientId: "ungranted-actor" }]);
  });

  // GROUND: DESIGN §3 ("deduplicate typed identities after eligibility"); PRD N3.
  it("explicitRemote visible ⇒ kept, deduped against the pool", () => {
    const habitatId = setupTeamHabitat([{ userId: "owner-1", role: "owner" }]);
    const { task } = seedTask(habitatId);
    const p = seedRemoteParticipantVisibleOnTask(habitatId, task.id, "remote_orcy");
    const out = resolveAudience({
      habitatId,
      eventType: "task.blocked",
      intents: [{ kind: "remote_visible", targetType: "task", targetId: task.id, explicitRemote: [{ recipientType: "remote_orcy", recipientId: p.id }] }],
    });
    expect(out.candidates.filter((c) => c.recipientId === p.id)).toHaveLength(1);
  });

  // GROUND: CORE-TASKS §1 correction 6 (mission/habitat target scoping); DESIGN §3 `remote_visible` row; PRD N3.
  it("habitat/mission/task target outside the command habitat ⇒ MISSING_CONTEXT_TARGET", () => {
    const habitatA = setupTeamHabitat([{ userId: "owner-a", role: "owner" }]);
    const habitatB = setupTeamHabitat([{ userId: "owner-b", role: "owner" }]);
    const { task } = seedTask(habitatB);
    expectIntentError(
      () => resolveAudience({ habitatId: habitatA, eventType: "task.blocked", intents: [{ kind: "remote_visible", targetType: "task", targetId: task.id }] }),
      "MISSING_CONTEXT_TARGET",
    );
    expectIntentError(
      () => resolveAudience({ habitatId: habitatA, eventType: "task.blocked", intents: [{ kind: "remote_visible", targetType: "habitat", targetId: habitatB }] }),
      "MISSING_CONTEXT_TARGET",
    );
  });
});

/* ---------- T4: atomic enqueue + classified outcomes, BOTH backends ---------- */

type Backend = "sqljs" | "file";
async function initBackend(b: Backend, dir: string) {
  if (b === "sqljs") return initTestDb();
  return initDb(path.join(dir, `${b}-${randomUUID()}.sqlite`));
}

function twoRecipientCommand(habitatId: string) {
  const agent = insertAgent("atomic-agent");
  return {
    habitatId,
    eventType: "task.blocked" as const,
    sourceType: "task" as const,
    severity: "warning" as const,
    createdByType: "system" as const,
    intents: [
      { kind: "exact" as const, recipients: [{ recipientType: "human" as const, recipientId: "member-1" }] },
      { kind: "exact" as const, recipients: [{ recipientType: "agent" as const, recipientId: agent.id }] },
    ],
  };
}

for (const backend of ["sqljs", "file"] as const) {
  describe(`intent core — atomic enqueue (${backend} backend, N6/N7)`, () => {
    let dir: string;
    beforeEach(async () => {
      resetInject();
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "orcy-intent-core-"));
      await initBackend(backend, dir);
    });
    afterEach(() => {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // GROUND: DESIGN §5 ("Failure at first/later Delivery or destination freeze rolls back the whole enqueue scope" — Event failure likewise); PRD N6.
    it("event-insert failure rolls back zero writes", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      const command = twoRecipientCommand(habitatId);
      inject.event = true;
      expect(() => enqueueNotificationWithIntents(command)).toThrow("INJECTED_EVENT_FAILURE");
      expect(eventCount()).toBe(0);
      expect(deliveryCount()).toBe(0);
    });

    // GROUND: DESIGN §5; PRD N6 ("Failure on any planned Delivery/freeze rolls back all enqueue writes").
    it("FIRST delivery failure rolls back the event insert", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      inject.deliveryOnCall = 1;
      expect(() => enqueueNotificationWithIntents(twoRecipientCommand(habitatId))).toThrow("INJECTED_DELIVERY_FAILURE");
      expect(eventCount()).toBe(0);
      expect(deliveryCount()).toBe(0);
    });

    // GROUND: DESIGN §5; PRD N6 — later-write failure rolls back the earlier Delivery too.
    it("SECOND delivery failure rolls back the first delivery AND the event", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      inject.deliveryOnCall = 2;
      expect(() => enqueueNotificationWithIntents(twoRecipientCommand(habitatId))).toThrow("INJECTED_DELIVERY_FAILURE");
      expect(eventCount()).toBe(0);
      expect(deliveryCount()).toBe(0);
    });

    // GROUND: DESIGN §5 ("reject unsupported/ambiguous/inconsistent identities before Event insertion"); PRD §5 + N7.
    it("resolution error leaves zero writes (preflight precedes the Event insert)", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      insertUser("outsider-1");
      expectIntentError(
        () => enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "outsider-1" }] }]),
        "INVALID_EXACT_RECIPIENT",
      );
      expect(eventCount()).toBe(0);
      expect(deliveryCount()).toBe(0);
    });

    // GROUND: DESIGN §6 ("Distinguish enqueued, intentional Event-only, supported empty audience"); PRD N7.
    it("event_only: legitimate empty audience commits the Event with zero deliveries, classified", () => {
      const habitatId = setupPersonalHabitat(); // unowned ⇒ no_recipients
      const r = enqueue(habitatId, [{ kind: "habitat_members" }]);
      expect(r.outcome).toBe("event_only");
      expect(r.deliveries).toHaveLength(0);
      expect(r.emptyReasons).toEqual(["no_recipients"]);
      expect(eventCount()).toBe(1);
      expect(deliveryCount()).toBe(0);
    });

    // GROUND: DESIGN §5 ("Failure at ... destination freeze rolls back the whole enqueue scope") + declared-scope composition; PRD N6.
    it("freeze failure rolls back inner raw and managed savepoints before outer cleanup", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      const db = getDb();
      const command = twoRecipientCommand(habitatId);
      const units = () => (db.get(sql`SELECT count(*) AS n FROM notification_delivery_channel_states`) as { n: number }).n;
      db.run(sql`CREATE TEMP TRIGGER fail_intent_freeze BEFORE INSERT ON notification_delivery_channel_states BEGIN SELECT RAISE(ABORT, 'INJECTED_FREEZE_FAILURE'); END`);
      try {
        db.run(sql`BEGIN IMMEDIATE`);
        try {
          expect(() => enqueueNotificationWithIntents(command, { outer: "reserved-immediate" })).toThrow(/INJECTED_FREEZE_FAILURE/);
          expect([eventCount(), deliveryCount(), units()]).toEqual([0, 0, 0]);
        } finally { db.run(sql`ROLLBACK`); }
        db.transaction(() => {
          expect(() => enqueueNotificationWithIntents(command, { outer: "reserved-immediate" })).toThrow(/INJECTED_FREEZE_FAILURE/);
          expect([eventCount(), deliveryCount(), units()]).toEqual([0, 0, 0]);
        }, { behavior: "immediate" });
        expect([eventCount(), deliveryCount(), units()]).toEqual([0, 0, 0]);
      } finally { db.run(sql`DROP TRIGGER fail_intent_freeze`); }
    });

    // GROUND: DESIGN §5 ("Existing Release outer rollback still removes the entire operation") + CORE-TASKS §1 correction 11; PRD N6.
    it("managed outer rollback removes event, delivery and frozen unit", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      const db = getDb();
      const command = twoRecipientCommand(habitatId);
      const agentId = command.intents[1].recipients[0].recipientId;
      const units = () => (db.get(sql`SELECT count(*) AS n FROM notification_delivery_channel_states`) as { n: number }).n;
      expect(() => db.transaction(() => {
        enqueueNotificationWithIntents(command, { outer: "reserved-immediate" });
        expect(eventCount()).toBe(1);
        expect(deliveryCount()).toBeGreaterThan(0);
        expect(units()).toBeGreaterThan(0);
        throw new Error("OUTER_ROLLBACK");
      }, { behavior: "immediate" })).toThrow("OUTER_ROLLBACK");
      expect(agentRepo.getAgentById(agentId)).toBeTruthy();
      expect([eventCount(), deliveryCount(), units()]).toEqual([0, 0, 0]);
    });

    // GROUND: DESIGN §5 declared-scope contract (caller holds BEGIN IMMEDIATE, enqueue savepoint-joins); CORE-TASKS §1 correction 11; PRD N6.
    it("outer raw BEGIN IMMEDIATE rollback discards the whole enqueue (declared composition)", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      const db = getDb();
      db.run(sql`BEGIN IMMEDIATE`);
      try {
        const r = enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }], { outer: "reserved-immediate" });
        expect(r.outcome).toBe("enqueued"); // savepoint-joined, succeeds inside the outer tx
      } finally {
        db.run(sql`ROLLBACK`);
      }
      expect(eventCount()).toBe(0);
      expect(deliveryCount()).toBe(0);
    });

    // GROUND: DESIGN §5 ("reject unsupported deferred composition rather than silently claiming reservation"); CORE-TASKS §1 correction 11; PRD N6.
    it("undeclared RAW DEFERRED outer transaction ⇒ typed UNSUPPORTED_OUTER_SCOPE, zero writes (deferred-negative, §1 correction 11)", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      const db = getDb();
      db.run(sql`BEGIN`); // deferred — NOT a writer reservation
      try {
        expectIntentError(
          () => enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]),
          "UNSUPPORTED_OUTER_SCOPE",
        );
        expect(eventCount()).toBe(0);
        expect(deliveryCount()).toBe(0);
      } finally {
        db.run(sql`ROLLBACK`);
      }
      expect(eventCount()).toBe(0);
      expect(deliveryCount()).toBe(0);
    });

    // GROUND: DESIGN §5 + CORE-TASKS §1 correction 11 (managed deferred is equally undeclared); PRD N6.
    it("undeclared MANAGED DEFERRED outer transaction ⇒ typed UNSUPPORTED_OUTER_SCOPE, zero writes (deferred-negative)", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      expectIntentError(
        () =>
          getDb().transaction(() => {
            enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }]);
          }), // drizzle default behavior is deferred — an unreserved snapshot
        "UNSUPPORTED_OUTER_SCOPE",
      );
      expect(eventCount()).toBe(0);
      expect(deliveryCount()).toBe(0);
    });

    // GROUND: CORE-TASKS §1 correction 11 (a succeeding probe proves the declaration false ⇒ typed OUTER_SCOPE_NOT_ACTIVE); PRD N6.
    it("declared reserved-immediate with NO active transaction ⇒ typed OUTER_SCOPE_NOT_ACTIVE, zero writes (fail-closed lie detector)", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      expectIntentError(
        () => enqueue(habitatId, [{ kind: "exact", recipients: [{ recipientType: "human", recipientId: "member-1" }] }], { outer: "reserved-immediate" }),
        "OUTER_SCOPE_NOT_ACTIVE",
      );
      expect(eventCount()).toBe(0);
      expect(deliveryCount()).toBe(0);
    });

    // GROUND: DESIGN §5 (savepoint join inside a declared outer scope) + CORE-TASKS §3 atomicity matrix; PRD N6.
    it("delivery failure INSIDE an outer raw tx leaves no partial writes (savepoint rollback)", () => {
      const habitatId = setupTeamHabitat([{ userId: "member-1", role: "member" }]);
      defaultSub(habitatId);
      inject.deliveryOnCall = 2;
      const db = getDb();
      db.run(sql`BEGIN IMMEDIATE`);
      try {
        expect(() => enqueueNotificationWithIntents(twoRecipientCommand(habitatId), { outer: "reserved-immediate" })).toThrow("INJECTED_DELIVERY_FAILURE");
        // Observe the enqueue savepoint BEFORE rolling back the enclosing tx.
        // Otherwise the outer rollback would hide a missing inner rollback.
        expect(eventCount()).toBe(0);
        expect(deliveryCount()).toBe(0);
      } finally {
        db.run(sql`ROLLBACK`);
      }
      expect(eventCount()).toBe(0);
      expect(deliveryCount()).toBe(0);
    });
  });
}
