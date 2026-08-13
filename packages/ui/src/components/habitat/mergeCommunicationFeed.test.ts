import { describe, expect, it } from "vitest";
import { mergeCommunicationFeed } from "./mergeCommunicationFeed.js";
import type { MissionComment, Pulse } from "../../types/index.js";

function pulse(id: string, createdAt: string, subject = "signal"): Pulse {
  return {
    id,
    missionId: "m1",
    habitatId: "h1",
    scope: "mission",
    fromType: "human",
    fromId: "u1",
    toType: null,
    toId: null,
    signalType: "finding",
    subject,
    body: "body",
    taskId: null,
    replyToId: null,
    linkedTaskId: null,
    metadata: {},
    createdAt,
    pinned: 0,
    isAuto: false,
  };
}

function comment(id: string, createdAt: string, content = "note"): MissionComment {
  return {
    id,
    missionId: "m1",
    authorType: "human",
    authorId: "u1",
    content,
    parentId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("mergeCommunicationFeed", () => {
  it("interleaves Pulse and comments by createdAt descending", () => {
    const items = mergeCommunicationFeed(
      [
        pulse("p-old", "2026-08-13T10:00:00.000Z"),
        pulse("p-new", "2026-08-13T12:00:00.000Z"),
      ],
      [comment("c1", "2026-08-13T11:00:00.000Z")],
    );

    expect(items.map((item) => item.kind)).toEqual(["pulse", "comment", "pulse"]);
    expect(items[0].kind === "pulse" && items[0].pulse.id).toBe("p-new");
    expect(items[1].kind === "comment" && items[1].comment.id).toBe("c1");
    expect(items[2].kind === "pulse" && items[2].pulse.id).toBe("p-old");
  });

  it("can show only Pulse or only comments", () => {
    const pulses = [pulse("p1", "2026-08-13T12:00:00.000Z")];
    const comments = [comment("c1", "2026-08-13T11:00:00.000Z")];

    expect(mergeCommunicationFeed(pulses, comments, { kind: "pulse" }).map((i) => i.kind)).toEqual([
      "pulse",
    ]);
    expect(mergeCommunicationFeed(pulses, comments, { kind: "comment" }).map((i) => i.kind)).toEqual([
      "comment",
    ]);
  });

  it("breaks timestamp ties with Pulse before comment", () => {
    const at = "2026-08-13T12:00:00.000Z";
    const items = mergeCommunicationFeed([pulse("p1", at)], [comment("c1", at)]);
    expect(items.map((item) => item.kind)).toEqual(["pulse", "comment"]);
  });
});
