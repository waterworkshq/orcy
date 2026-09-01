/**
 * Repository null-contract tests (sql.js).
 *
 * Locks the absence contract of the public nullable repository reads: when
 * the row does not exist, the repository returns literal `null` — never the
 * runtime `undefined` that Drizzle's `.get()` produces before normalization.
 * `getMissionById` already normalizes its public result and is locked here as
 * a behavior guarantee for its internal exact-read cleanup.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { v4 as uuid } from "uuid";
import { closeDb, initTestDb } from "../db/index.js";
import {
  getById as getCandidateById,
  findByConnectionAndExternalId as findCandidateByConnectionAndExternalId,
} from "../repositories/externalIntakeCandidate.js";
import {
  getById as getIssueLinkById,
  findByConnectionAndExternalId as findIssueLinkByConnectionAndExternalId,
} from "../repositories/externalIssueLink.js";
import { getLatestHealthSnapshot } from "../repositories/habitatHealth.js";
import { getById as getConnectionById } from "../repositories/integrationConnection.js";
import { getById as getSyncRunById } from "../repositories/integrationSyncRun.js";
import { getMissionById } from "../repositories/mission.js";
import { getById as getReviewRuleById } from "../repositories/reviewRule.js";
import { getActiveForHabitat } from "../repositories/sprint.js";
import { getById as getTaskReviewerById } from "../repositories/taskReviewer.js";

describe("repository null contract", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("externalIntakeCandidate.getById returns null for a missing id", () => {
    expect(getCandidateById(uuid())).toBeNull();
  });

  it("externalIntakeCandidate.findByConnectionAndExternalId returns null for a missing pair", () => {
    expect(findCandidateByConnectionAndExternalId(uuid(), uuid())).toBeNull();
  });

  it("externalIssueLink.getById returns null for a missing id", () => {
    expect(getIssueLinkById(uuid())).toBeNull();
  });

  it("externalIssueLink.findByConnectionAndExternalId returns null for a missing pair", () => {
    expect(findIssueLinkByConnectionAndExternalId(uuid(), uuid())).toBeNull();
  });

  it("habitatHealth.getLatestHealthSnapshot returns null for a habitat with no snapshots", () => {
    expect(getLatestHealthSnapshot(uuid())).toBeNull();
  });

  it("integrationConnection.getById returns null for a missing id", () => {
    expect(getConnectionById(uuid())).toBeNull();
  });

  it("integrationSyncRun.getById returns null for a missing id", () => {
    expect(getSyncRunById(uuid())).toBeNull();
  });

  it("mission.getMissionById returns null for a missing id in both id shapes", () => {
    expect(getMissionById(uuid())).toBeNull();
    expect(getMissionById(`mission-${uuid()}`)).toBeNull();
  });

  it("reviewRule.getById returns null for a missing id", () => {
    expect(getReviewRuleById(uuid())).toBeNull();
  });

  it("sprint.getActiveForHabitat returns null for a habitat with no active sprint", () => {
    expect(getActiveForHabitat(uuid())).toBeNull();
  });

  it("taskReviewer.getById returns null for a missing id", () => {
    expect(getTaskReviewerById(uuid())).toBeNull();
  });
});
