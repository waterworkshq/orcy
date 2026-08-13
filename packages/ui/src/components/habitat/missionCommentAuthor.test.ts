import { describe, expect, it } from "vitest";
import { missionCommentAuthorLabel } from "./missionCommentAuthor.js";
import type { MissionComment } from "../../types/index.js";

function comment(authorType: MissionComment["authorType"]): MissionComment {
  return {
    id: "c1",
    missionId: "m1",
    parentId: null,
    authorType,
    authorId: "abcd1234ffff",
    content: "note",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
  };
}

describe("missionCommentAuthorLabel", () => {
  it("keeps remote standing distinct from local human and agent", () => {
    expect(missionCommentAuthorLabel(comment("human"))).toBe("Human");
    expect(missionCommentAuthorLabel(comment("agent"))).toBe("abcd1234");
    expect(missionCommentAuthorLabel(comment("remote_human"))).toBe("Remote: abcd1234");
    expect(missionCommentAuthorLabel(comment("remote_orcy"))).toBe("Remote Or: abcd1234");
  });
});
