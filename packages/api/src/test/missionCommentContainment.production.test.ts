/**
 * Mission comment containment — PRODUCTION DRIVER proofs (better-sqlite3 file
 * DB, repository boundary, FK enforcement on). Not production-driver HTTP
 * evidence: these prove the repository primitives' final-statement semantics on
 * the driver production actually serves, not only the sql.js test driver:
 * required Mission+typed-author `UPDATE … RETURNING`, the cascade-fenced
 * `DELETE … RETURNING id`, the conditional reply `INSERT … SELECT … WHERE
 * EXISTS`, and the parent FK that still enforces what the schema owns. No
 * `.run().changes` semantics anywhere — results come from RETURNING rows only.
 * There is no Mission foreign key on `mission_comments`, so no missing-Mission
 * probe is invented here; the parent FK probe is the honest boundary probe.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as commentRepo from "../repositories/featureComment.js";
import * as commentMentionRepo from "../repositories/featureCommentMention.js";
import { missionComments, missionCommentMentions } from "../db/schema/index.js";

let dbFile: string;
let habitatId: string;
let missionIdA: string;
let missionIdB: string;
const AUTHOR = { authorType: "agent" as const, authorId: "mcp-author" } as const;
const HUMAN_AUTHOR = { authorType: "human" as const, authorId: "mcp-human" } as const;
const REMOTE_AUTHOR = { authorType: "remote_orcy" as const, authorId: "mcp-remote" } as const;
type Attribution = { authorType: "human" | "agent" | "remote_human" | "remote_orcy"; authorId: string };

let columnOrder = 0;
function makeMission(label: string): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: `mcp-col-${label}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  return missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `mcp-mission-${label}`,
    createdBy: "mcp-seed",
  }).id;
}

function seedComment(
  missionId: string,
  content: string,
  parentId: string | null = null,
  author: Attribution = AUTHOR,
): string {
  return commentRepo.createComment({
    missionId,
    parentId,
    content,
    authorType: author.authorType,
    authorId: author.authorId,
  }).id;
}

/** Pins the stored attribution, so a "mixed-author" claim cannot rest on a label. */
function expectAttribution(commentId: string, author: Attribution): void {
  const stored = row(commentId);
  expect(stored, `row ${commentId}`).toBeDefined();
  expect(stored!.authorType, `authorType of ${commentId}`).toBe(author.authorType);
  expect(stored!.authorId, `authorId of ${commentId}`).toBe(author.authorId);
}

function row(commentId: string) {
  return getDb().select().from(missionComments).where(eq(missionComments.id, commentId)).get();
}

function rowsFor(missionId: string) {
  return getDb()
    .select()
    .from(missionComments)
    .where(eq(missionComments.missionId, missionId))
    .all();
}

function mentionsFor(commentId: string) {
  return getDb()
    .select()
    .from(missionCommentMentions)
    .where(eq(missionCommentMentions.commentId, commentId))
    .all();
}

function seedMention(commentId: string, name: string): string {
  return commentMentionRepo.createMentions([
    {
      commentId,
      mentionedType: "human",
      mentionedId: `mcp-mention-${name}`,
      mentionText: `@${name}`,
    },
  ])[0]!.id;
}

/** Cross-Mission parent links are legal under the simple self-FK (parent exists) with enforcement ON. */
function rawCrossMissionChild(parentId: string, missionId: string): string {
  const id = `mcp-cross-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  getDb()
    .insert(missionComments)
    .values({
      id,
      missionId,
      parentId,
      authorType: "human",
      authorId: "mcp-other-author",
      content: "cross-mission",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

/**
 * Commissioned FK-integrity proof state on the production driver: enforcement
 * explicitly enabled and asserted (PRAGMA + a functional missing-PARENT INSERT)
 * BEFORE legal cross-Mission/cycle fixtures are created. There is no Mission FK,
 * so the probe targets the parent reference the schema really owns.
 */
function enableFk(): void {
  getDb().run(sql`PRAGMA foreign_keys = ON`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(1);
  expect(() =>
    getDb()
      .insert(missionComments)
      .values({
        id: `mcp-fk-probe-${Math.random().toString(36).slice(2, 8)}`,
        missionId: missionIdA,
        parentId: "00000000-0000-4000-8000-0000000000ff",
        authorType: "agent",
        authorId: "mcp-fk-probe",
        content: "fk enforcement check",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run(),
  ).toThrow(/FOREIGN KEY/i);
}

beforeEach(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-mcp-")), "orcy.db");
  await initDb(dbFile);
  habitatId = habitatRepo.createHabitat({ name: "mcp-habitat" }).id;
  missionIdA = makeMission("a");
  missionIdB = makeMission("b");
  enableFk();
});

afterEach(() => {
  closeDb();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe("PRODUCTION DRIVER — required Mission + typed author primitives", () => {
  it("createReplyComment: a matched parent returns the row; a wrong-Mission or missing parent returns null and writes nothing", () => {
    const parent = seedComment(missionIdA, "parent");
    const reply = commentRepo.createReplyComment({
      missionId: missionIdA,
      parentId: parent,
      authorType: AUTHOR.authorType,
      authorId: AUTHOR.authorId,
      content: "reply",
    });
    expect(reply).not.toBeNull();
    expect(reply!.missionId).toBe(missionIdA);
    expect(reply!.parentId).toBe(parent);
    expect((reply as unknown as { mentions: unknown[] }).mentions).toEqual([]);
    const afterMatch = rowsFor(missionIdA).length;

    // Parent exists but belongs to another Mission: zero rows, no new comment.
    const otherParent = seedComment(missionIdB, "b-parent");
    expect(
      commentRepo.createReplyComment({
        missionId: missionIdA,
        parentId: otherParent,
        authorType: AUTHOR.authorType,
        authorId: AUTHOR.authorId,
        content: "cross",
      }),
    ).toBeNull();

    // No parent at all: the FK would reject a plain INSERT; the conditional
    // INSERT simply matches nothing.
    expect(
      commentRepo.createReplyComment({
        missionId: missionIdA,
        parentId: "00000000-0000-4000-8000-0000000000c9",
        authorType: AUTHOR.authorType,
        authorId: AUTHOR.authorId,
        content: "orphan",
      }),
    ).toBeNull();
    expect(rowsFor(missionIdA)).toHaveLength(afterMatch);
  }, 30_000);

  it("updateComment: the exact pair + typed author matches with its mention projection; wrong Mission/author/absent match zero and leave the row untouched", () => {
    const comment = seedComment(missionIdA, "original");
    const mentionId = seedMention(comment, "driver-update");

    const matched = commentRepo.updateComment(
      missionIdA,
      comment,
      AUTHOR.authorType,
      AUTHOR.authorId,
      "edited",
    );
    expect(matched).not.toBeNull();
    expect(matched!.content).toBe("edited");
    expect(
      (matched as unknown as { mentions: Array<{ id: string }> }).mentions.map((m) => m.id),
    ).toEqual([mentionId]);

    // Unchanged content is still a MATCH, not a zero-match.
    expect(
      commentRepo.updateComment(missionIdA, comment, AUTHOR.authorType, AUTHOR.authorId, "edited"),
    ).not.toBeNull();

    const afterMatch = row(comment)!;
    for (const attempt of [
      [missionIdB, comment, AUTHOR.authorType, AUTHOR.authorId],
      [missionIdA, comment, "human", AUTHOR.authorId],
      [missionIdA, comment, AUTHOR.authorType, "someone-else"],
      [missionIdA, "00000000-0000-4000-8000-0000000000ff", AUTHOR.authorType, AUTHOR.authorId],
    ] as Array<[string, string, "human" | "agent", string]>) {
      expect(
        commentRepo.updateComment(attempt[0], attempt[1], attempt[2], attempt[3], "hijacked"),
        `pair=${attempt[0]} id=${attempt[1]} type=${attempt[2]}`,
      ).toBeNull();
    }
    const afterMisses = row(comment)!;
    expect(afterMisses.content).toBe(afterMatch.content);
    expect(afterMisses.updatedAt).toBe(afterMatch.updatedAt);
    expect(mentionsFor(comment).map((m) => m.id)).toEqual([mentionId]);
  }, 30_000);

  it("deleteComment: the cascade fence refuses a DEEP cross-Mission descendant and preserves every row", () => {
    const root = seedComment(missionIdA, "root");
    const child = seedComment(missionIdA, "child", root);
    const foreign = rawCrossMissionChild(child, missionIdB);
    const before = [root, child, foreign].map((id) => row(id));

    expect(commentRepo.deleteComment(missionIdA, root, AUTHOR.authorType, AUTHOR.authorId)).toBe(
      false,
    );
    expect([root, child, foreign].map((id) => row(id))).toEqual(before);
  }, 30_000);

  it("deleteComment: a same-Mission genuinely MIXED-author thread cascades and cleans up every mention; a wrong pair or author matches zero", () => {
    // Three distinct stored attributions, each pinned before the delete, so the
    // mixed-author claim rests on the rows rather than on the seed labels.
    const root = seedComment(missionIdA, "root", null, AUTHOR);
    const child = seedComment(missionIdA, "child", root, HUMAN_AUTHOR);
    const grandchild = seedComment(missionIdA, "grandchild", child, REMOTE_AUTHOR);
    // Every one of the three rows carries a nonempty mention, so cascade cleanup
    // is observable on all three.
    for (const [id, name] of [
      [root, "driver-root"],
      [child, "driver-child"],
      [grandchild, "driver-grandchild"],
    ] as Array<[string, string]>) {
      seedMention(id, name);
      expect(mentionsFor(id).length, `seeded mention on ${id}`).toBe(1);
    }
    expectAttribution(root, AUTHOR);
    expectAttribution(child, HUMAN_AUTHOR);
    expectAttribution(grandchild, REMOTE_AUTHOR);
    const distinctAuthors = new Set(
      [root, child, grandchild].map((id) => `${row(id)!.authorType}:${row(id)!.authorId}`),
    );
    expect(distinctAuthors.size, "three distinct stored authors").toBe(3);

    // Wrong Mission pair and wrong typed author both match zero, with no loss.
    expect(commentRepo.deleteComment(missionIdB, root, AUTHOR.authorType, AUTHOR.authorId)).toBe(
      false,
    );
    expect(commentRepo.deleteComment(missionIdA, root, "human", AUTHOR.authorId)).toBe(false);
    // Same scalar id, wrong type: must be refused by the TYPED-author predicate.
    expect(
      commentRepo.deleteComment(missionIdA, root, "human" as const, AUTHOR.authorId),
    ).toBe(false);
    for (const id of [root, child, grandchild]) {
      expect(row(id), `row ${id} preserved`).toBeDefined();
      expect(mentionsFor(id).length, `mentions ${id} preserved`).toBe(1);
    }

    expect(commentRepo.deleteComment(missionIdA, root, AUTHOR.authorType, AUTHOR.authorId)).toBe(
      true,
    );
    for (const id of [root, child, grandchild]) {
      expect(row(id), `row ${id} removed`).toBeUndefined();
      expect(mentionsFor(id), `mentions ${id} removed`).toEqual([]);
    }
  }, 30_000);
});
