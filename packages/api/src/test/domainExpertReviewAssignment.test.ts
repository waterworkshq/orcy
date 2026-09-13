/**
 * domain_expert reviewer routing restoration — behavior-first contract tests.
 *
 * Scope (implementation contract, capability-recovery epic, rev 4):
 *  - `domain_expert` selects AGENT reviewers by exact `agents.domain` match
 *    against the task's current `requiredDomain`. Never a human pick: no
 *    human fallback, no fullstack wildcard, no team-pool involvement.
 *  - Works on a no-team habitat AND a zero-human team habitat alike (the
 *    pool is the global live agent registry).
 *  - Ordering: non-offline before offline (preference, never admission),
 *    least agent-typed pending reviews, createdAt DESC, id ASC.
 *  - Typed anti-self at the pool: the current assignee is excluded.
 *  - Slot accounting (E): existing agent rows count ONLY when their live
 *    registry agent still exact-matches the CURRENT domain and is not the
 *    current assignee (any row status). Deleted-agent rows and assignee
 *    rows stay untouched completion requirements that never fulfill
 *    domain slots. Existing rows of any type are never re-picked
 *    (type-blind collision skip before slot selection).
 *  - No new rows when E >= requiredReviews; raising requiredReviews fills
 *    exactly the difference; lowering never removes rows.
 *  - Human strategies (fixed/round_robin/least_loaded/random) keep today's
 *    team-pool behavior, including the no-team/zero-human skips.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as taskService from "../services/tasks/index.js";
import * as reviewAssignment from "../services/reviewAssignmentService.js";
import * as automationExecutor from "../services/automationExecutor.js";
import { agents, habitats, users, teamMembers, teams, organizations } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Fixture {
  habitatId: string;
  missionId: string;
}

function setupHabitat(withEmptyTeam = false): Fixture {
  const habitat = habitatRepo.createHabitat({ name: `Domain Habitat ${Date.now()}` });
  if (withEmptyTeam) {
    const db = getDb();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.insert(organizations)
      .values({ id: `org-${suffix}`, name: `O-${suffix}`, slug: `org-${suffix}` })
      .run();
    db.insert(teams)
      .values({
        id: `team-${suffix}`,
        organizationId: `org-${suffix}`,
        name: `T-${suffix}`,
        slug: `team-${suffix}`,
      })
      .run();
    db.update(habitats)
      .set({ teamId: `team-${suffix}` })
      .where(eq(habitats.id, habitat.id))
      .run();
  }
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Domain Mission",
    createdBy: "test",
  });
  return { habitatId: habitat.id, missionId: mission.id };
}

function makeAgent(name: string, domain: string): string {
  const { agent } = agentRepo.createAgent({ name, type: "codex", domain });
  return agent.id;
}

function setAgentStatus(agentId: string, status: "idle" | "working" | "offline"): void {
  getDb().update(agents).set({ status }).where(eq(agents.id, agentId)).run();
}

/** Raw insert with controlled id and createdAt for deterministic ordering proofs. */
function insertAgentRaw(id: string, name: string, domain: string, createdAt: string): string {
  getDb()
    .insert(agents)
    .values({
      id,
      name,
      type: "codex",
      domain,
      capabilities: [],
      status: "idle",
      apiKey: `raw-key-${id}`,
      createdAt,
      lastHeartbeat: createdAt,
      metadata: {},
    })
    .run();
  return id;
}

function insertUser(id: string, username: string): void {
  getDb().insert(users).values({ id, username, passwordHash: "x", displayName: username }).run();
}

function attachHumanTeam(fixture: Fixture, names: string[]): string[] {
  const db = getDb();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.insert(organizations)
    .values({ id: `org-${suffix}`, name: `O-${suffix}`, slug: `org-${suffix}` })
    .run();
  const teamId = `team-${suffix}`;
  db.insert(teams)
    .values({ id: teamId, organizationId: `org-${suffix}`, name: `T-${suffix}`, slug: teamId })
    .run();
  db.update(habitats).set({ teamId }).where(eq(habitats.id, fixture.habitatId)).run();
  const ids: string[] = [];
  names.forEach((name, i) => {
    const uid = `user-${name}-${suffix}-${i}`;
    insertUser(uid, `${name}-${suffix}`);
    db.insert(teamMembers)
      .values({ id: `tm-${uid}`, teamId, userId: uid })
      .run();
    ids.push(uid);
  });
  return ids;
}

function createDomainTask(fixture: Fixture, requiredDomain: string | null): string {
  const task = taskRepo.createTask({
    missionId: fixture.missionId,
    title: `Task-${Math.random().toString(36).slice(2)}`,
    createdBy: "test",
    requiredDomain,
  });
  return task.id;
}

function domainRule(habitatId: string, requiredReviews = 1): string {
  const rule = reviewRuleRepo.create(habitatId, {
    name: "domain rule",
    assignmentStrategy: "domain_expert",
    requiredReviews,
  });
  return rule.id;
}

function rowsFor(taskId: string) {
  return taskReviewerRepo.getByTaskId(taskId);
}

/** Pending agent-typed workload on an unrelated task, to shift the ordering key. */
function addPendingWorkload(agentId: string, fixture: Fixture, count = 1): void {
  for (let i = 0; i < count; i++) {
    const otherId = createDomainTask(fixture, null);
    taskReviewerRepo.create(otherId, "agent", agentId);
  }
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// F1 — habitat matrix: the domain branch never consults the human team pool
// ---------------------------------------------------------------------------

describe("domain_expert habitat matrix (real submitTask)", () => {
  it("strategy-less rule defaults to the domain branch: real submitTask assigns an agent-typed row", () => {
    const fixture = setupHabitat(true);
    // No assignmentStrategy on the rule — schema default is 'domain_expert',
    // which must route to the agent-domain pool (not the old first-human
    // placeholder).
    reviewRuleRepo.create(fixture.habitatId, { name: "default-strategy rule", requiredReviews: 1 });
    const humanId = attachHumanTeam(fixture, ["alice"])[0];
    const worker = makeAgent("default-worker", "backend");
    const reviewer = makeAgent("default-reviewer", "backend");
    const taskId = createDomainTask(fixture, "backend");

    taskRepo.claimTask(taskId, worker);
    taskRepo.startTask(taskId, worker);
    const submitted = taskService.submitTask(taskId, worker, "done", []);

    expect(submitted.task).not.toBeNull();
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewerType).toBe("agent");
    expect(rows[0].reviewerId).toBe(reviewer);
    expect(rows[0].reviewerId).not.toBe(humanId);
  });

  it("no-team habitat: real submitTask assigns the domain-matching agent (agent-typed row)", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const worker = makeAgent("worker-no-team", "backend");
    const reviewer = makeAgent("reviewer-no-team", "backend");
    const taskId = createDomainTask(fixture, "backend");

    taskRepo.claimTask(taskId, worker);
    taskRepo.startTask(taskId, worker);
    const submitted = taskService.submitTask(taskId, worker, "done", []);

    expect(submitted.task).not.toBeNull();
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewerType).toBe("agent");
    expect(rows[0].reviewerId).toBe(reviewer);
    expect(rows[0].status).toBe("pending");
  });

  it("zero-human team habitat: real submitTask assigns the domain-matching agent", () => {
    const fixture = setupHabitat(true);
    domainRule(fixture.habitatId, 1);
    const worker = makeAgent("worker-empty-team", "backend");
    const reviewer = makeAgent("reviewer-empty-team", "backend");
    const taskId = createDomainTask(fixture, "backend");

    taskRepo.claimTask(taskId, worker);
    taskRepo.startTask(taskId, worker);
    const submitted = taskService.submitTask(taskId, worker, "done", []);

    expect(submitted.task).not.toBeNull();
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewerType).toBe("agent");
    expect(rows[0].reviewerId).toBe(reviewer);
  });

  it("human strategy on the same habitats keeps today's no-team skip byte-for-byte", () => {
    const fixture = setupHabitat(false);
    reviewRuleRepo.create(fixture.habitatId, {
      name: "human rule",
      assignmentStrategy: "least_loaded",
      requiredReviews: 1,
    });
    makeAgent("agent-irrelevant", "backend");
    const taskId = createDomainTask(fixture, "backend");
    const worker = makeAgent("worker-human-skip", "backend");

    taskRepo.claimTask(taskId, worker);
    taskRepo.startTask(taskId, worker);
    const submitted = taskService.submitTask(taskId, worker, "done", []);

    expect(submitted.task).not.toBeNull();
    expect(rowsFor(taskId)).toHaveLength(0);
  });

  it("human strategy on a zero-human team habitat keeps today's skip", () => {
    const fixture = setupHabitat(true);
    reviewRuleRepo.create(fixture.habitatId, {
      name: "human rule",
      assignmentStrategy: "least_loaded",
      requiredReviews: 1,
    });
    const taskId = createDomainTask(fixture, "backend");

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no_eligible_reviewers");
    expect(rowsFor(taskId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Wrong-pick discriminators
// ---------------------------------------------------------------------------

describe("domain_expert wrong-pick discriminators", () => {
  it("picks the domain-matching agent — never the first human, never the first agent by registry order", () => {
    const fixture = setupHabitat(true);
    domainRule(fixture.habitatId, 1);
    attachHumanTeam(fixture, ["alice"]);
    const match = makeAgent("match-backend", "backend");
    // Newer createdAt → FIRST in listAgents' createdAt DESC order, wrong domain.
    makeAgent("newest-mismatch", "frontend");

    const taskId = createDomainTask(fixture, "backend");
    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);

    expect(result.skipped).toBe(false);
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0].reviewerId).toBe(match);
    expect(result.assigned[0].reviewerType).toBe("agent");
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewerType).toBe("agent");
    expect(rows[0].reviewerId).toBe(match);
  });

  it("never picks a human even when only humans are available (no human fallback)", () => {
    const fixture = setupHabitat(true);
    domainRule(fixture.habitatId, 1);
    attachHumanTeam(fixture, ["alice", "bob"]);
    const taskId = createDomainTask(fixture, "backend");

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no_eligible_reviewers");
    expect(rowsFor(taskId)).toHaveLength(0);
  });

  it("fullstack wildcard is NOT applied — exact domain match only", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    makeAgent("fullstack-generalist", "fullstack");
    const taskId = createDomainTask(fixture, "backend");

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no_eligible_reviewers");
    expect(rowsFor(taskId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F4 — ordering
// ---------------------------------------------------------------------------

describe("domain_expert ordering", () => {
  it("non-offline beats offline even when the offline agent is newer", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    // Controlled createdAt: offline is decisively newer (would win createdAt DESC).
    const online = insertAgentRaw(
      "agent-online-older",
      "online-older",
      "backend",
      "2026-09-12 10:00:00",
    );
    const offline = insertAgentRaw(
      "agent-offline-newer",
      "offline-newer",
      "backend",
      "2026-09-12 10:00:01",
    );
    setAgentStatus(offline, "offline");

    const taskId = createDomainTask(fixture, "backend");
    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.assigned[0].reviewerId).toBe(online);
  });

  it("offline agent is still assignable when it is the only match (offline ≠ revoked)", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const only = makeAgent("only-offline", "backend");
    setAgentStatus(only, "offline");

    const taskId = createDomainTask(fixture, "backend");
    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(false);
    expect(result.assigned[0].reviewerId).toBe(only);
  });

  it("least agent-typed pending reviews wins over createdAt", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    // Controlled createdAt: busy is decisively newer (would win createdAt DESC).
    const busy = insertAgentRaw("agent-busy-newer", "busy-newer", "backend", "2026-09-12 10:00:01");
    const free = insertAgentRaw("agent-free-older", "free-older", "backend", "2026-09-12 10:00:00");
    addPendingWorkload(busy, fixture, 2);

    const taskId = createDomainTask(fixture, "backend");
    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.assigned[0].reviewerId).toBe(free);
  });

  it("equal pending and equal createdAt → id ASC decides, not insertion order", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const sameSecond = "2026-09-12 10:00:00";
    // Inserted FIRST but sorts LAST by id — creation order must not decide.
    insertAgentRaw("agent-zzz-first-created", "raw-z", "backend", sameSecond);
    insertAgentRaw("agent-aaa-second-created", "raw-a", "backend", sameSecond);

    const taskId = createDomainTask(fixture, "backend");
    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.assigned[0].reviewerId).toBe("agent-aaa-second-created");
  });

  it("a human-typed pending row sharing the id does not inflate the agent ordering key", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    // Controlled createdAt: the colliding agent is decisively newer (would win
    // createdAt DESC). If human-typed rows inflated its AGENT pending count,
    // it would lose to the older agent instead.
    const colliding = insertAgentRaw(
      "agent-humankey-newer",
      "humankey-newer",
      "backend",
      "2026-09-12 10:00:01",
    );
    insertAgentRaw("agent-humankey-older", "humankey-older", "backend", "2026-09-12 10:00:00");
    const otherTask = createDomainTask(fixture, null);
    taskReviewerRepo.create(otherTask, "human", colliding);

    const taskId = createDomainTask(fixture, "backend");
    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.assigned[0].reviewerId).toBe("agent-humankey-newer");
  });
});

// ---------------------------------------------------------------------------
// Anti-self and collisions
// ---------------------------------------------------------------------------

describe("domain_expert pool exclusion and collisions", () => {
  it("typed anti-self at the pool: the current assignee is excluded even when it would be top pick", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    // Controlled createdAt: the assignee is decisively newer → would be the
    // top pick if the pool failed to exclude it.
    insertAgentRaw("agent-other-older", "other-backend", "backend", "2026-09-12 10:00:00");
    const assignee = insertAgentRaw(
      "agent-assignee-newer",
      "assignee-backend",
      "backend",
      "2026-09-12 10:00:01",
    );
    const taskId = createDomainTask(fixture, "backend");
    taskRepo.claimTask(taskId, assignee);

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(false);
    expect(result.assigned[0].reviewerId).toBe("agent-other-older");
    const rows = rowsFor(taskId);
    expect(rows.some((r) => r.reviewerId === assignee)).toBe(false);
  });

  it("assignee as the only match → skip, assignee never assigned", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const assignee = makeAgent("lone-assignee", "backend");
    const taskId = createDomainTask(fixture, "backend");
    taskRepo.claimTask(taskId, assignee);

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no_eligible_reviewers");
    expect(rowsFor(taskId)).toHaveLength(0);
  });

  it("type-blind collision: agent id already holding a human row is skipped, next candidate fills", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const collide = makeAgent("collide-id", "backend"); // zero pending → top of order
    const next = makeAgent("next-candidate", "backend");
    addPendingWorkload(next, fixture, 1); // collide is decisively top
    const taskId = createDomainTask(fixture, "backend");
    // Pre-existing HUMAN row whose id string equals the top agent's id.
    taskReviewerRepo.create(taskId, "human", collide);

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(false);
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0].reviewerId).toBe(next);
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(2);
    const collideRow = rows.find((r) => r.reviewerId === collide);
    expect(collideRow?.reviewerType).toBe("human"); // untouched, never duplicated
  });
});

// ---------------------------------------------------------------------------
// Zero-match / NULL-domain
// ---------------------------------------------------------------------------

describe("domain_expert zero-match and NULL-domain skips", () => {
  it("no live agent matches the domain → skip no_eligible_reviewers, zero rows, no human", () => {
    const fixture = setupHabitat(true);
    domainRule(fixture.habitatId, 1);
    attachHumanTeam(fixture, ["alice"]);
    makeAgent("unrelated-frontend", "frontend");
    const taskId = createDomainTask(fixture, "no-such-domain");

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no_eligible_reviewers");
    expect(rowsFor(taskId)).toHaveLength(0);
  });

  it("requiredDomain NULL → skip, zero rows, no human pick", () => {
    const fixture = setupHabitat(true);
    domainRule(fixture.habitatId, 1);
    attachHumanTeam(fixture, ["alice"]);
    makeAgent("backend-anyway", "backend");
    const taskId = createDomainTask(fixture, null);

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("no_eligible_reviewers");
    expect(rowsFor(taskId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Slot accounting — E rule, idempotency, refills
// ---------------------------------------------------------------------------

describe("domain_expert slot accounting (E rule)", () => {
  it("requiredReviews 2 with one match → one row, truthful partial assignment", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 2);
    const only = makeAgent("only-match", "backend");
    const taskId = createDomainTask(fixture, "backend");

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(false);
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0].reviewerId).toBe(only);
    expect(rowsFor(taskId)).toHaveLength(1);
  });

  it("repeat assignment with same workload emits ZERO new rows (E=1, remaining=0)", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    makeAgent("repeat-a", "backend");
    const taskId = createDomainTask(fixture, "backend");

    const first = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(first.assigned).toHaveLength(1);
    const second = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(second.assigned).toHaveLength(0);
    expect(second.skipped).toBe(true);
    expect(rowsFor(taskId)).toHaveLength(1);
  });

  it("unrelated workload shift reorders the pool but still emits ZERO new rows (idempotency rests on E, not pick stability)", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const a = makeAgent("stable-a", "backend");
    const taskId = createDomainTask(fixture, "backend");
    const first = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(first.assigned[0].reviewerId).toBe(a);
    // Unrelated workload change: a now carries pending load; b is free → b would be the pick.
    addPendingWorkload(a, fixture, 1);
    const b = makeAgent("stable-b", "backend");

    const second = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(second.assigned).toHaveLength(0);
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.reviewerId === b)).toBe(false);
  });

  it("raising requiredReviews fills exactly the difference; further calls emit zero", () => {
    const fixture = setupHabitat(false);
    const ruleId = domainRule(fixture.habitatId, 1);
    const a = makeAgent("raise-a", "backend");
    const b = makeAgent("raise-b", "backend");
    const c = makeAgent("raise-c", "backend");
    const taskId = createDomainTask(fixture, "backend");

    expect(reviewAssignment.assignReviewers(taskId, fixture.habitatId).assigned).toHaveLength(1);

    reviewRuleRepo.update(ruleId, { requiredReviews: 2 });
    const second = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(second.assigned).toHaveLength(1);
    expect(rowsFor(taskId)).toHaveLength(2);

    reviewRuleRepo.update(ruleId, { requiredReviews: 3 });
    const third = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(third.assigned).toHaveLength(1);
    expect(rowsFor(taskId)).toHaveLength(3);

    const fourth = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(fourth.assigned).toHaveLength(0);
    expect(rowsFor(taskId)).toHaveLength(3);
    const ids = new Set(rowsFor(taskId).map((r) => r.reviewerId));
    expect(ids.has(a)).toBe(true);
    expect(ids.has(b)).toBe(true);
    expect(ids.has(c)).toBe(true);
  });

  it("resubmit after rejection cycle: E counts the retained rejected row → zero new rows, no duplicates", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const a = makeAgent("cycle-a", "backend");
    const b = makeAgent("cycle-b", "backend");
    addPendingWorkload(b, fixture, 1); // a is decisively the first pick
    const taskId = createDomainTask(fixture, "backend");

    reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    const row = taskReviewerRepo.findByTaskAndReviewer(taskId, a, "agent");
    expect(row).not.toBeNull();
    taskReviewerRepo.updateStatus(row!.id, "rejected", "not good");

    const again = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(again.assigned).toHaveLength(0);
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected"); // history preserved
    expect(rows.some((r) => r.reviewerId === b)).toBe(false);
  });

  it("domain update on the agent re-evaluates E against the CURRENT domain and fills the positive remainder", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const drift = makeAgent("drift-agent", "backend");
    const stay = makeAgent("stay-agent", "backend");
    addPendingWorkload(stay, fixture, 1); // drift is decisively the first pick
    const taskId = createDomainTask(fixture, "backend");

    reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    // drift's row exists; drift's domain is edited away → E=0 → stay fills.
    agentRepo.updateAgent(drift, { domain: "frontend" });

    const refill = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(refill.assigned).toHaveLength(1);
    expect(refill.assigned[0].reviewerId).toBe(stay);
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.reviewerId === drift)?.status).toBe("pending"); // untouched
  });

  it("task requiredDomain edit re-evaluates E against the CURRENT domain", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    makeAgent("backend-agent", "backend");
    const fe = makeAgent("frontend-agent", "frontend");
    const taskId = createDomainTask(fixture, "backend");

    reviewAssignment.assignReviewers(taskId, fixture.habitatId); // backend agent row
    taskRepo.updateTask(taskId, { requiredDomain: "frontend" } as any);

    const refill = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(refill.assigned).toHaveLength(1);
    expect(refill.assigned[0].reviewerId).toBe(fe);
    expect(rowsFor(taskId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F5 — dangling rows (deleted agents)
// ---------------------------------------------------------------------------

describe("domain_expert dangling rows", () => {
  it("deleted agent's existing row does not count E; live match fills; dangling row untouched", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const dead = makeAgent("dead-agent", "backend");
    const live = makeAgent("live-agent", "backend");
    addPendingWorkload(live, fixture, 1); // dead would be top if it counted… it must not even be picked
    const taskId = createDomainTask(fixture, "backend");
    const dangling = taskReviewerRepo.create(taskId, "agent", dead);
    agentRepo.deleteAgent(dead);

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(false);
    expect(result.assigned[0].reviewerId).toBe(live);
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(2);
    const still = rows.find((r) => r.reviewerId === dead);
    expect(still?.id).toBe(dangling.id); // never auto-removed
    expect(still?.status).toBe("pending");
  });

  it("assignee's existing row does not count E; a different live match fills; row never auto-removed", () => {
    const fixture = setupHabitat(false);
    domainRule(fixture.habitatId, 1);
    const a = makeAgent("assignee-holder", "backend");
    const b = makeAgent("other-match", "backend");
    const taskId = createDomainTask(fixture, "backend");
    const held = taskReviewerRepo.create(taskId, "agent", a); // row exists pre-claim
    taskRepo.claimTask(taskId, a); // a becomes the assignee

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.skipped).toBe(false);
    expect(result.assigned[0].reviewerId).toBe(b);
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === held.id)?.status).toBe("pending"); // untouched
  });
});

// ---------------------------------------------------------------------------
// F3 — completion interplay with unrelated rows
// ---------------------------------------------------------------------------

describe("domain_expert completion interplay", () => {
  it("human row + domain slot: completion requires BOTH rows approved", () => {
    const fixture = setupHabitat(true);
    domainRule(fixture.habitatId, 1);
    const humanId = attachHumanTeam(fixture, ["alice"])[0];
    const a = makeAgent("pair-agent", "backend");
    const taskId = createDomainTask(fixture, "backend");
    taskReviewerRepo.create(taskId, "human", humanId); // human POST row

    const result = reviewAssignment.assignReviewers(taskId, fixture.habitatId);
    expect(result.assigned).toHaveLength(1);
    expect(rowsFor(taskId)).toHaveLength(2);

    expect(reviewAssignment.hasAllRequiredApprovals(taskId)).toBe(false);
    reviewAssignment.recordApproval(taskId, a, "agent");
    expect(reviewAssignment.hasAllRequiredApprovals(taskId)).toBe(false); // human row still pending
    reviewAssignment.recordApproval(taskId, humanId, "human");
    expect(reviewAssignment.hasAllRequiredApprovals(taskId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Automation rule-driven path
// ---------------------------------------------------------------------------

describe("automation request_review (rule-driven) uses the restored domain selection", () => {
  it("no explicit reviewerId on a domain_expert rule → agent-typed row via domain match", async () => {
    const fixture = setupHabitat(true);
    domainRule(fixture.habitatId, 1);
    const worker = makeAgent("auto-worker", "backend");
    const reviewer = makeAgent("auto-reviewer", "backend");
    const taskId = createDomainTask(fixture, "backend");
    taskRepo.claimTask(taskId, worker);
    taskRepo.startTask(taskId, worker);
    taskRepo.submitTask(taskId, worker, "work", []);

    const rule = { id: "r1", habitatId: fixture.habitatId, actions: [] } as any;
    const run = { id: "run-1" } as any;
    const ctx = { task: taskRepo.getTaskById(taskId) } as any;
    const result = await automationExecutor.executeAction(
      { type: "request_review" } as any,
      0,
      rule,
      run,
      ctx,
    );

    expect(result.status).toBe("succeeded");
    const rows = rowsFor(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewerType).toBe("agent");
    expect(rows[0].reviewerId).toBe(reviewer);
  });
});
