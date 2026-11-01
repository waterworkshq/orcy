/**
 * Issue #139 — task-notification EMAIL recipient authorization.
 *
 * Real repositories, real preference resolution, the real habitat-access
 * predicate (checkHabitatAccess), the real notification service, email service
 * and templates. Only the nodemailer transport is stubbed: the final
 * sendMail envelope is captured and no connection or mail is possible.
 *
 * The production path (sse/broadcaster.ts notifySafe -> processEvent) reaches
 * the same processEvent exercised here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyRequest } from "fastify";

// SMTP env must be set before emailService.ts loads (it reads env at module
// scope); the transport itself is stubbed below so nothing is ever sent.
vi.hoisted(() => {
  process.env.SMTP_HOST = "smtp.proof.invalid";
  process.env.SMTP_USER = "proof-user";
  process.env.SMTP_PASS = "proof-pass";
  process.env.SMTP_FROM = "noreply@proof.invalid";
});

interface CapturedEnvelope {
  from: string;
  to: string;
  subject: string;
  html: string;
}

const sentEnvelopes: CapturedEnvelope[] = [];

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      sendMail: async (envelope: CapturedEnvelope) => {
        sentEnvelopes.push(envelope);
      },
    }),
  },
}));

import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as userRepo from "../repositories/user.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as prefRepo from "../repositories/notificationPreferences.js";
import * as columnRepo from "../repositories/column.js";
import { processEvent, type NotificationEventType } from "../services/notificationService.js";
import { checkHabitatAccess } from "../middleware/realtimeAuth.js";

const TASK_TITLE = "Proof Secret Title Alpha";
const TEAM_HABITAT_NAME = "Proof Private Team Habitat";
const NONMEMBER_ADMIN_EMAIL = "proof-admin-external@example.invalid";
const MEMBER_ADMIN_EMAIL = "proof-member@example.invalid";
const ACTOR_EMAIL = "proof-actor@example.invalid";

const EVENTS: Array<[NotificationEventType, "taskSubmitted" | "taskOverdue" | "taskPriorityChanged", string]> = [
  ["task.submitted", "taskSubmitted", "Task submitted for review: "],
  ["task.overdue", "taskOverdue", "Task overdue: "],
  ["task.priority_changed", "taskPriorityChanged", "Task priority changed: "],
];

function mkUser(id: string, username: string, role: "admin" | "editor", email: string): void {
  const now = new Date().toISOString();
  userRepo.createUser({
    id,
    username,
    passwordHash: "proof-hash",
    displayName: username,
    role,
    createdAt: now,
    updatedAt: now,
  });
  userRepo.updateUserEmail(id, email);
}

function seedTeamHabitatWorld() {
  const org = organizationRepo.createOrganization({ name: "proof-org", slug: "proof-org" });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "proof-team", slug: "proof-team" });
  const habitat = habitatRepo.createHabitat({ name: TEAM_HABITAT_NAME, teamId: team.id });
  columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });

  mkUser("proof-actor", "proof-actor", "editor", ACTOR_EMAIL);
  teamMemberRepo.addMember({ teamId: team.id, userId: "proof-actor", role: "member" });
  // Deployment-wide admin with NO membership in the habitat's team.
  mkUser("proof-admin-ext", "proof-admin-ext", "admin", NONMEMBER_ADMIN_EMAIL);
  // Membership control: deployment-wide admin who IS a team member.
  mkUser("proof-member-admin", "proof-member-admin", "admin", MEMBER_ADMIN_EMAIL);
  teamMemberRepo.addMember({ teamId: team.id, userId: "proof-member-admin", role: "admin" });

  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    title: "Proof Mission",
    createdBy: "proof-actor",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: TASK_TITLE,
    createdBy: "proof-actor",
  });
  return { teamId: team.id, habitatId: habitat.id, taskId: task.id };
}

function seedPersonalHabitatWorld() {
  // Personal habitats have no team, so the nonmember admin is admitted by the
  // personal-habitat rule itself — these users must exist here too.
  mkUser("proof-actor", "proof-actor", "editor", ACTOR_EMAIL);
  mkUser("proof-admin-ext", "proof-admin-ext", "admin", NONMEMBER_ADMIN_EMAIL);
  const habitat = habitatRepo.createHabitat({ name: "Proof Personal Habitat" });
  columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    title: "Proof Personal Mission",
    createdBy: "proof-actor",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: TASK_TITLE,
    createdBy: "proof-actor",
  });
  return { habitatId: habitat.id, taskId: task.id };
}

function humanRequest(userId: string): FastifyRequest {
  return { user: { id: userId, role: "admin" } } as unknown as FastifyRequest;
}

const sendsTo = (email: string): CapturedEnvelope[] =>
  sentEnvelopes.filter((envelope) => envelope.to === email);

function fireEvent(eventType: NotificationEventType, habitatId: string, taskId: string): Promise<void> {
  return processEvent(eventType, habitatId, {
    taskId,
    actorId: "proof-actor",
    oldPriority: eventType === "task.priority_changed" ? "medium" : undefined,
    newPriority: eventType === "task.priority_changed" ? "critical" : undefined,
  });
}

describe("task email recipient authorization (issue #139)", () => {
  beforeEach(async () => {
    await initTestDb();
    sentEnvelopes.length = 0;
  });
  afterEach(() => closeDb());

  it("read-surface parity: checkHabitatAccess admits the member admin and denies the nonmember admin with 403 BOARD_ACCESS_DENIED", async () => {
    const { habitatId } = seedTeamHabitatWorld();
    await expect(checkHabitatAccess(humanRequest("proof-member-admin"), habitatId)).resolves.toBeUndefined();
    await expect(checkHabitatAccess(humanRequest("proof-admin-ext"), habitatId)).rejects.toMatchObject({
      statusCode: 403,
      code: "BOARD_ACCESS_DENIED",
    });
  });

  it.each(EVENTS)("%s: nonmember deployment-wide admin receives no email for a private team habitat", async (eventType) => {
    const { habitatId, taskId } = seedTeamHabitatWorld();
    await fireEvent(eventType, habitatId, taskId);
    const leaked = sendsTo(NONMEMBER_ADMIN_EMAIL);
    expect(leaked).toHaveLength(0);
    expect(leaked.map((e) => e.subject).join("\n")).not.toContain(TASK_TITLE);
    expect(leaked.map((e) => e.html).join("\n")).not.toContain(TEAM_HABITAT_NAME);
  });

  it.each(EVENTS)("%s: authorized member admin still receives the enabled email with habitat content", async (eventType, _prefField, subjectPrefix) => {
    const { habitatId, taskId } = seedTeamHabitatWorld();
    await fireEvent(eventType, habitatId, taskId);
    const received = sendsTo(MEMBER_ADMIN_EMAIL);
    expect(received).toHaveLength(1);
    expect(received[0].subject).toBe(subjectPrefix + TASK_TITLE);
    expect(received[0].html).toContain(TEAM_HABITAT_NAME);
  });

  it.each(EVENTS)("%s: preference opt-out suppresses delivery for the authorized member", async (eventType, prefField) => {
    const { habitatId, taskId } = seedTeamHabitatWorld();
    prefRepo.upsertPreferences("proof-member-admin", habitatId, { [prefField]: false });
    await fireEvent(eventType, habitatId, taskId);
    expect(sendsTo(MEMBER_ADMIN_EMAIL)).toHaveLength(0);
  });

  it.each(EVENTS)("%s: personal habitat keeps authenticated-human semantics — nonmember global admin still receives", async (eventType, _prefField, subjectPrefix) => {
    const { habitatId, taskId } = seedPersonalHabitatWorld();
    await fireEvent(eventType, habitatId, taskId);
    const received = sendsTo(NONMEMBER_ADMIN_EMAIL);
    expect(received).toHaveLength(1);
    expect(received[0].subject).toBe(subjectPrefix + TASK_TITLE);
  });

  it("missing habitat id fails closed: no email and no 'Unknown Habitat' disclosure fallback", async () => {
    const { taskId } = seedTeamHabitatWorld();
    await fireEvent("task.submitted", "habitat-that-does-not-exist", taskId);
    expect(sentEnvelopes).toHaveLength(0);
  });
});

// --- PR149 review fix: bounded authorization query work --------------------
//
// The disclosure gate must batch its reads ONCE PER EVENT (one habitat read +
// one current-membership query) no matter how many recipients the event fans
// out to. The per-recipient form issued two synchronous queries per global
// admin on every bulk task event (review finding on notificationService.ts).
// The tests above pin WHO is admitted; these pin the WORK: exact statement
// counts, so a regression back to per-recipient reads fails on query work.
//
// Instrumentation: every drizzle sql-js query goes through
// `client.prepare(sql)` (SQLiteSyncDialect -> SQLJsSession.prepareQuery), so
// wrapping the raw client's prepare captures each statement exactly once.
// The capture window closes before sendIfEnabled's preference/email reads
// (those run as Promise.allSettled microtasks after processEvent's
// synchronous section).
function captureAuthorizationStatements(run: () => unknown): string[] {
  const client = (
    getDb() as unknown as {
      session: { client: { prepare: (source: string) => unknown } };
    }
  ).session.client;
  const statements: string[] = [];
  const originalPrepare = client.prepare;
  client.prepare = (source: string) => {
    statements.push(source);
    return originalPrepare.call(client, source);
  };
  try {
    run();
  } finally {
    client.prepare = originalPrepare;
  }
  return statements;
}

describe("task email authorization query work (PR149 review)", () => {
  beforeEach(async () => {
    await initTestDb();
    sentEnvelopes.length = 0;
  });
  afterEach(() => closeDb());

  it("task.submitted authorizes N recipients with ONE habitat read and ONE membership query", async () => {
    const { teamId, habitatId, taskId } = seedTeamHabitatWorld();
    // Grow the recipient set: task.submitted fans out to EVERY deployment
    // admin. Base fixture contributes 3 admins (actor is editor); 5 more
    // here (2 current team members, 3 nonmembers) => 8 recipients.
    const expectedMemberEmails = [MEMBER_ADMIN_EMAIL];
    const expectedNonmemberEmails = [NONMEMBER_ADMIN_EMAIL];
    for (let n = 0; n < 5; n++) {
      const id = `proof-bulk-${n}`;
      const email = `${id}@example.invalid`;
      mkUser(id, id, "admin", email);
      if (n < 2) {
        teamMemberRepo.addMember({ teamId, userId: id, role: "member" });
        expectedMemberEmails.push(email);
      } else {
        expectedNonmemberEmails.push(email);
      }
    }

    // The fan-out set: every deployment admin is a task.submitted recipient.
    const recipients = userRepo.getAdmins();
    expect(recipients).toHaveLength(8);

    let pending: Promise<void> = Promise.resolve();
    const statements = captureAuthorizationStatements(() => {
      pending = fireEvent("task.submitted", habitatId, taskId);
    });
    await pending;

    // Bounded work — exact statement counts, independent of the 8-recipient
    // fan-out. Prepare-count arithmetic (drizzle sql-js session): a
    // field-projected `.all()` prepares the same SQL TWICE (once discarded
    // in `all()`, once inside `values()`); a `.get()` prepares ONCE. So the
    // batched gate = ONE logical membership query (2 prepares) + ONE
    // authorization habitat read (1 prepare), plus processEvent's own
    // habitat-name lookup (1 prepare) => 2 membership + 2 habitat prepares.
    // The per-recipient form this pins out = 8x2 membership + 1+8x1 habitat.
    expect(statements.filter((s) => s.includes('from "team_members"'))).toHaveLength(2);
    expect(statements.filter((s) => s.includes('from "habitats"'))).toHaveLength(2);

    // Delivery parity under the batched gate: exactly the current members.
    for (const email of expectedMemberEmails) {
      expect(sendsTo(email), email).toHaveLength(1);
    }
    for (const email of expectedNonmemberEmails) {
      expect(sendsTo(email), email).toHaveLength(0);
    }
    expect(sentEnvelopes).toHaveLength(expectedMemberEmails.length);
  });

  it("candidate set beyond SQLite's 32766 host-parameter ceiling still authorizes: habitat-keyed query, zero recipient-bound parameters", () => {
    const { habitatId } = seedTeamHabitatWorld();
    // 33001 candidates (1 real member + 33000 synthetic ids never inserted)
    // exceed SQLITE_MAX_VARIABLE_NUMBER (32766). An `in`-list keyed by the
    // candidate set would throw — and merely failing closed there would LOSE
    // the real member's notification. The membership query must therefore
    // bind only the habitat id and intersect in JS.
    const candidates = [
      "proof-member-admin",
      ...Array.from({ length: 33000 }, (_, n) => `synthetic-candidate-${n}`),
    ];
    let authorized: Set<string> = new Set();
    const statements = captureAuthorizationStatements(() => {
      authorized = teamMemberRepo.humansWithHabitatAccess(habitatId, candidates);
    });
    // Intersection semantics: exactly the real member, none of the synthetics,
    // and members NOT in the candidate set (proof-actor) stay out.
    expect(authorized).toEqual(new Set(["proof-member-admin"]));
    // Query shape: the membership SQL binds exactly ONE value (the habitat
    // id) — work independent of candidate-set size by construction.
    const membershipSql = statements.filter((s) => s.includes('from "team_members"'));
    expect(membershipSql).toHaveLength(2); // drizzle projected `.all()` double-prepare
    for (const sql of membershipSql) {
      expect(sql.split("?").length - 1).toBe(1);
    }
  });

  it("event with no recipients issues no membership query and no authorization habitat read", async () => {
    const { habitatId, taskId } = seedTeamHabitatWorld();
    // task.assigned with no assignedAgentId builds an empty queue.
    let pending: Promise<void> = Promise.resolve();
    const statements = captureAuthorizationStatements(() => {
      pending = fireEvent("task.assigned", habitatId, taskId);
    });
    await pending;
    expect(statements.filter((s) => s.includes('from "team_members"'))).toHaveLength(0);
    // Only processEvent's own habitat-name lookup runs.
    expect(statements.filter((s) => s.includes('from "habitats"'))).toHaveLength(1);
    expect(sentEnvelopes).toHaveLength(0);
  });
});

// --- SINGLE-USER admission query shape ---------------------------------------
//
// checkHabitatAccess (realtimeAuth middleware — presence heartbeat every 30s,
// mission/task guards) calls humanCanAccessHabitat for ONE user per request.
// Delegating that to the batch helper (humansWithHabitatAccess) would make
// every such request load the habitat's ENTIRE team roster. These tests pin
// the single-user query WORK: the
// membership query must bind BOTH the habitat id and the user id (selective
// predicate) and materialize at most one row, independent of team size.
//
// Instrumentation extends captureAuthorizationStatements with row counting:
// drizzle's projected `.all()` delegates to `values()`, which prepares its own
// statement, binds, and steps rows (the first prepared statement is discarded
// unexecuted) — so the executed statement is the one that binds.
interface CapturableStatement {
  bind: (params: unknown[]) => void;
  step: () => boolean;
  get: (...args: unknown[]) => unknown;
  getAsObject: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => unknown;
  free: () => void;
}

interface StatementWork {
  sql: string;
  boundParams: number;
  rowsStepped: number;
}

function captureAuthorizationWork(run: () => unknown): StatementWork[] {
  const client = (
    getDb() as unknown as {
      session: { client: { prepare: (source: string) => CapturableStatement } };
    }
  ).session.client;
  const work: StatementWork[] = [];
  const originalPrepare = client.prepare;
  client.prepare = (source: string) => {
    const stmt = originalPrepare.call(client, source);
    const entry: StatementWork = { sql: source, boundParams: 0, rowsStepped: 0 };
    work.push(entry);
    return {
      bind: (params: unknown[]) => {
        entry.boundParams = params.length;
        return stmt.bind(params);
      },
      step: () => {
        const hasRow = stmt.step();
        if (hasRow) entry.rowsStepped += 1;
        return hasRow;
      },
      get: (...args: unknown[]) => stmt.get(...args),
      getAsObject: (...args: unknown[]) => stmt.getAsObject(...args),
      run: (...args: unknown[]) => stmt.run(...args),
      free: () => stmt.free(),
    };
  };
  try {
    run();
  } finally {
    client.prepare = originalPrepare;
  }
  return work;
}

function assertSingleUserMembershipShape(work: StatementWork[], expectedRows: number): void {
  const membership = work.filter((w) => w.sql.includes('from "team_members"'));
  // drizzle projected `.all()` double-prepares; both carry the SQL shape.
  expect(membership).toHaveLength(2);
  for (const stmt of membership) {
    // Selective predicate: BOTH the habitat id and the USER id are bound
    // values — a habitat-only query (the batch shape) materializes the roster.
    expect(stmt.sql.split("?").length - 1).toBe(2);
  }
  // Exactly one statement really executes (binds); it materializes at most
  // the queried user's single row, never the team roster.
  const executed = membership.filter((stmt) => stmt.boundParams > 0);
  expect(executed).toHaveLength(1);
  expect(executed[0].boundParams).toBe(2);
  expect(executed[0].rowsStepped).toBe(expectedRows);
}

describe("single-user habitat admission query shape", () => {
  beforeEach(async () => {
    await initTestDb();
    sentEnvelopes.length = 0;
  });
  afterEach(() => closeDb());

  it("humanCanAccessHabitat binds the user predicate and materializes one row on a 3300-member team", () => {
    const { teamId, habitatId } = seedTeamHabitatWorld();
    for (let n = 0; n < 3300; n++) {
      const id = `proof-roster-${n}`;
      mkUser(id, id, "editor", `${id}@example.invalid`);
      teamMemberRepo.addMember({ teamId, userId: id, role: "member" });
    }

    let admitted = false;
    const memberWork = captureAuthorizationWork(() => {
      admitted = teamMemberRepo.humanCanAccessHabitat(habitatId, "proof-member-admin");
    });
    expect(admitted).toBe(true);
    assertSingleUserMembershipShape(memberWork, 1);

    let denied = true;
    const nonmemberWork = captureAuthorizationWork(() => {
      denied = teamMemberRepo.humanCanAccessHabitat(habitatId, "proof-admin-ext");
    });
    expect(denied).toBe(false);
    assertSingleUserMembershipShape(nonmemberWork, 0);
  });

  it("access parity on team and missing habitats: single-user and batch helpers agree", () => {
    const team = seedTeamHabitatWorld();
    const cases: Array<[string, string, boolean]> = [
      [team.habitatId, "proof-member-admin", true],
      [team.habitatId, "proof-actor", true],
      [team.habitatId, "proof-admin-ext", false],
      ["habitat-that-does-not-exist", "proof-member-admin", false],
    ];
    for (const [habitatId, userId, expected] of cases) {
      expect(teamMemberRepo.humanCanAccessHabitat(habitatId, userId), `${habitatId}/${userId}`).toBe(expected);
      expect(teamMemberRepo.humansWithHabitatAccess(habitatId, [userId]).has(userId), `${habitatId}/${userId}`).toBe(expected);
    }
  });

  it("access parity on personal habitats: single-user and batch helpers agree", () => {
    const personal = seedPersonalHabitatWorld();
    for (const userId of ["proof-actor", "proof-admin-ext"]) {
      expect(teamMemberRepo.humanCanAccessHabitat(personal.habitatId, userId), userId).toBe(true);
      expect(teamMemberRepo.humansWithHabitatAccess(personal.habitatId, [userId]).has(userId), userId).toBe(true);
    }
  });
});
