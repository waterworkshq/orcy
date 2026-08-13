import { describe, expect, it } from "vitest";
import { mergeCommunicationFeed } from "./mergeCommunicationFeed.js";
import type { MissionComment, Pulse } from "../../types/index.js";

function pulse(overrides: Partial<Pulse> & Pick<Pulse, "id" | "createdAt">): Pulse {
  return {
    missionId: "m1",
    habitatId: "h1",
    scope: "mission",
    fromType: "human",
    fromId: "u1",
    toType: null,
    toId: null,
    signalType: "finding",
    subject: "signal",
    body: "body",
    taskId: null,
    replyToId: null,
    linkedTaskId: null,
    metadata: {},
    pinned: 0,
    isAuto: false,
    ...overrides,
  };
}

function comment(
  overrides: Partial<MissionComment> & Pick<MissionComment, "id" | "createdAt">,
): MissionComment {
  return {
    missionId: "m1",
    authorType: "human",
    authorId: "u1",
    content: "note",
    parentId: null,
    ...overrides,
    updatedAt: overrides.createdAt,
  };
}

describe("mergeCommunicationFeed", () => {
  it("interleaves Pulse and comments by createdAt descending without renaming comments", () => {
    const items = mergeCommunicationFeed(
      [
        pulse({ id: "p-old", createdAt: "2026-08-13T10:00:00.000Z", subject: "older pulse" }),
        pulse({ id: "p-new", createdAt: "2026-08-13T12:00:00.000Z", subject: "newer pulse" }),
      ],
      [comment({ id: "c1", createdAt: "2026-08-13T11:00:00.000Z", content: "mid comment" })],
    );

    expect(items.map((item) => item.kind)).toEqual(["pulse", "comment", "pulse"]);
    expect(items[0]).toMatchObject({ kind: "pulse", pulse: { id: "p-new" } });
    expect(items[1]).toMatchObject({ kind: "comment", comment: { id: "c1" } });
    expect(items[2]).toMatchObject({ kind: "pulse", pulse: { id: "p-old" } });
  });

  it("can show only Pulse or only comments", () => {
    const pulses = [pulse({ id: "p1", createdAt: "2026-08-13T12:00:00.000Z" })];
    const comments = [comment({ id: "c1", createdAt: "2026-08-13T11:00:00.000Z" })];

    expect(mergeCommunicationFeed(pulses, comments, { kind: "pulse" }).every((i) => i.kind === "pulse")).toBe(
      true,
    );
    expect(
      mergeCommunicationFeed(pulses, comments, { kind: "comment" }).every((i) => i.kind === "comment"),
    ).toBe(true);
  });

  it("breaks timestamp ties with Pulse before comment", () => {
    const at = "2026-08-13T12:00:00.000Z";
    const items = mergeCommunicationFeed(
      [pulse({ id: "p1", createdAt: at })],
      [comment({ id: "c1", createdAt: at })],
    );
    expect(items.map((item) => item.kind)).toEqual(["pulse", "comment"]);
  });
});
