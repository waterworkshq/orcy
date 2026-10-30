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

import { initTestDb, closeDb } from "../db/index.js";
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
