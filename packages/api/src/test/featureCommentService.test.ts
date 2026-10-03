import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../repositories/featureComment.js", () => ({
  createComment: vi.fn(),
  createReplyComment: vi.fn(),
  getCommentById: vi.fn(),
  getCommentsByMissionId: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));

const createMentionsMock = vi.hoisted(() => vi.fn(() => [] as any[]));

vi.mock("../repositories/featureCommentMention.js", () => ({
  createMentions: createMentionsMock,
}));

const resolveMentionsMock = vi.hoisted(() => vi.fn(() => [] as any[]));

vi.mock("../services/commentHelper.js", () => ({
  resolveMentions: resolveMentionsMock,
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: {
    publish: vi.fn(),
  },
}));

vi.mock("../repositories/mission.js", () => ({
  getMissionById: vi.fn(),
}));

vi.mock("../errors.js", async () => {
  const actual = await vi.importActual<typeof import("../errors.js")>("../errors.js");
  return { ...actual };
});

import {
  addComment,
  getComments,
  editComment,
  removeComment,
} from "../services/missionCommentService.js";
import * as commentRepo from "../repositories/featureComment.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { getMissionById } from "../repositories/mission.js";

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    missionId: "mission-1",
    parentId: null,
    authorType: "human",
    authorId: "user-1",
    content: "Hello",
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    ...overrides,
  };
}

function makeMission(overrides: Record<string, unknown> = {}) {
  return {
    id: "mission-1",
    habitatId: "habitat-1",
    title: "Test Mission",
    ...overrides,
  };
}

describe("featureCommentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveMentionsMock.mockReturnValue([]);
    createMentionsMock.mockReturnValue([]);
    vi.mocked(commentRepo.createComment).mockReturnValue(makeComment() as any);
    vi.mocked(commentRepo.createReplyComment).mockReturnValue(null);
    vi.mocked(commentRepo.getCommentById).mockReturnValue(null);
    vi.mocked(commentRepo.getCommentsByMissionId).mockReturnValue({ comments: [], total: 0 });
    vi.mocked(commentRepo.updateComment).mockReturnValue(null);
    vi.mocked(commentRepo.deleteComment).mockReturnValue(true);
    vi.mocked(getMissionById).mockReturnValue(null);
  });

  describe("addComment", () => {
    it("throws when mission not found", () => {
      vi.mocked(getMissionById).mockReturnValue(null);

      expect(() => addComment("missing-mission", "human", "user-1", "Hello")).toThrow(
        "Mission not found",
      );
    });

    it("throws when parent comment not found", () => {
      vi.mocked(getMissionById).mockReturnValue(makeMission() as any);
      vi.mocked(commentRepo.getCommentById).mockReturnValue(null);

      expect(() => addComment("mission-1", "human", "user-1", "Reply", "missing-parent")).toThrow(
        "Parent comment not found",
      );
    });

    it("throws when parent comment belongs to different mission", () => {
      vi.mocked(getMissionById).mockReturnValue(makeMission() as any);
      vi.mocked(commentRepo.getCommentById).mockReturnValue(
        makeComment({ missionId: "other-mission" }) as any,
      );

      expect(() => addComment("mission-1", "human", "user-1", "Reply", "parent-1")).toThrow(
        "Parent comment belongs to a different mission",
      );
    });

    it("creates comment and broadcasts", () => {
      vi.mocked(getMissionById).mockReturnValue(makeMission() as any);
      vi.mocked(commentRepo.createComment).mockReturnValue(
        makeComment({ id: "new-comment" }) as any,
      );

      const result = addComment("mission-1", "human", "user-1", "Hello");

      expect(result.id).toBe("new-comment");
      expect(commentRepo.createComment).toHaveBeenCalledWith({
        missionId: "mission-1",
        authorType: "human",
        authorId: "user-1",
        content: "Hello",
        parentId: null,
      });
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "habitat-1",
        expect.objectContaining({ type: "mission.commented" }),
      );
    });

    it("creates comment with mentions and broadcasts mention events", () => {
      vi.mocked(getMissionById).mockReturnValue(makeMission() as any);
      vi.mocked(commentRepo.createComment).mockReturnValue(makeComment({ id: "cmt-1" }) as any);
      resolveMentionsMock.mockReturnValue([
        {
          mentionedType: "human",
          mentionedId: "u1",
          mentionText: "@alice",
          mentionedName: "alice",
        },
      ]);
      createMentionsMock.mockReturnValue([
        {
          id: "m1",
          commentId: "cmt-1",
          mentionedType: "human",
          mentionedId: "u1",
          mentionText: "@alice",
          createdAt: "2025-01-01",
        },
      ] as any);

      const result = addComment("mission-1", "human", "user-1", "Hey @alice");

      expect(result.id).toBe("cmt-1");
      expect(createMentionsMock).toHaveBeenCalled();
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "habitat-1",
        expect.objectContaining({ type: "mission.mentioned" }),
      );
    });

    it("creates a reply through the conditional insert that re-checks the parent pair", () => {
      vi.mocked(getMissionById).mockReturnValue(makeMission() as any);
      vi.mocked(commentRepo.getCommentById).mockReturnValue(
        makeComment({ id: "parent-1", missionId: "mission-1" }) as any,
      );
      vi.mocked(commentRepo.createReplyComment).mockReturnValue(
        makeComment({ id: "reply-1", parentId: "parent-1" }) as any,
      );

      const result = addComment("mission-1", "human", "user-1", "Reply", "parent-1");

      expect(result.id).toBe("reply-1");
      expect(commentRepo.createReplyComment).toHaveBeenCalledWith({
        missionId: "mission-1",
        parentId: "parent-1",
        authorType: "human",
        authorId: "user-1",
        content: "Reply",
      });
      expect(commentRepo.createComment).not.toHaveBeenCalled();
    });

    it("maps a final conditional-INSERT miss to the parent error before mentions or events", () => {
      vi.mocked(getMissionById).mockReturnValue(makeMission() as any);
      vi.mocked(commentRepo.getCommentById).mockReturnValue(
        makeComment({ id: "parent-1", missionId: "mission-1" }) as any,
      );
      vi.mocked(commentRepo.createReplyComment).mockReturnValue(null);

      expect(() => addComment("mission-1", "human", "user-1", "Reply", "parent-1")).toThrow(
        "Parent comment not found",
      );
      expect(createMentionsMock).not.toHaveBeenCalled();
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });
  });

  describe("getComments", () => {
    it("delegates to comment repo", () => {
      vi.mocked(commentRepo.getCommentsByMissionId).mockReturnValue({
        comments: [makeComment() as any],
        total: 1,
      });

      const result = getComments("mission-1", 10, 0);

      expect(result.comments).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(commentRepo.getCommentsByMissionId).toHaveBeenCalledWith("mission-1", 10, 0);
    });
  });

  describe("editComment", () => {
    it("throws when comment not found", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(null);

      expect(() => editComment("mission-1", "missing", "human", "user-1", "Updated")).toThrow(
        "Comment not found",
      );
    });

    it("throws when the comment belongs to another mission", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(
        makeComment({ missionId: "mission-2" }) as any,
      );

      expect(() => editComment("mission-1", "comment-1", "human", "user-1", "Updated")).toThrow(
        "Comment not found",
      );
      expect(commentRepo.updateComment).not.toHaveBeenCalled();
    });

    it("throws when not authorized", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(
        makeComment({ authorType: "agent", authorId: "other-agent" }) as any,
      );

      expect(() => editComment("mission-1", "comment-1", "human", "user-1", "Updated")).toThrow(
        "Not authorized to edit this comment",
      );
      expect(commentRepo.updateComment).not.toHaveBeenCalled();
    });

    it("updates comment under the required pair and author", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(makeComment() as any);
      vi.mocked(commentRepo.updateComment).mockReturnValue(
        makeComment({ content: "Updated" }) as any,
      );

      const result = editComment("mission-1", "comment-1", "human", "user-1", "Updated");

      expect(result).not.toBeNull();
      expect(result!.content).toBe("Updated");
      expect(commentRepo.updateComment).toHaveBeenCalledWith(
        "mission-1",
        "comment-1",
        "human",
        "user-1",
        "Updated",
      );
    });

    it("throws when the final UPDATE matched no row", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(makeComment() as any);
      vi.mocked(commentRepo.updateComment).mockReturnValue(null);

      expect(() => editComment("mission-1", "comment-1", "human", "user-1", "Updated")).toThrow(
        "Comment not found",
      );
    });
  });

  describe("removeComment", () => {
    it("throws when comment not found", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(null);

      expect(() => removeComment("mission-1", "missing", "human", "user-1")).toThrow(
        "Comment not found",
      );
    });

    it("throws when the comment belongs to another mission", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(
        makeComment({ missionId: "mission-2" }) as any,
      );

      expect(() => removeComment("mission-1", "comment-1", "human", "user-1")).toThrow(
        "Comment not found",
      );
      expect(commentRepo.deleteComment).not.toHaveBeenCalled();
    });

    it("throws when not authorized", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(
        makeComment({ authorType: "agent", authorId: "other" }) as any,
      );

      expect(() => removeComment("mission-1", "comment-1", "human", "user-1")).toThrow(
        "Not authorized to delete this comment",
      );
      expect(commentRepo.deleteComment).not.toHaveBeenCalled();
    });

    it("deletes under the required pair and author and broadcasts", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(makeComment() as any);
      vi.mocked(getMissionById).mockReturnValue(makeMission() as any);

      const result = removeComment("mission-1", "comment-1", "human", "user-1");

      expect(result).toBe(true);
      expect(commentRepo.deleteComment).toHaveBeenCalledWith(
        "mission-1",
        "comment-1",
        "human",
        "user-1",
      );
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "habitat-1",
        expect.objectContaining({ type: "mission.comment_deleted" }),
      );
    });

    it("throws and emits no event when the final DELETE matched no row", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(makeComment() as any);
      vi.mocked(getMissionById).mockReturnValue(makeMission() as any);
      vi.mocked(commentRepo.deleteComment).mockReturnValue(false);

      expect(() => removeComment("mission-1", "comment-1", "human", "user-1")).toThrow(
        "Comment not found",
      );
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });

    it("still deletes when mission not found", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(makeComment() as any);
      vi.mocked(getMissionById).mockReturnValue(null);

      const result = removeComment("mission-1", "comment-1", "human", "user-1");

      expect(result).toBe(true);
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });
  });
});
