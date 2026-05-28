import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../repositories/comment.js", () => ({
  createComment: vi.fn(),
  getCommentById: vi.fn(),
  getCommentsByTaskId: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));
vi.mock("../repositories/task.js", () => ({ getTaskById: vi.fn(), getHabitatIdForTask: vi.fn() }));
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: vi.fn() } }));
vi.mock("../errors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../errors.js")>();
  return { ...actual };
});

const cmtMentionMocks = vi.hoisted(() => ({ createMentions: vi.fn(() => [] as any[]) }));
const helperMocks = vi.hoisted(() => ({ resolveMentions: vi.fn(() => [] as any[]) }));

vi.mock("../repositories/commentMention.js", () => ({
  createMentions: cmtMentionMocks.createMentions,
}));
vi.mock("../services/commentHelper.js", () => ({ resolveMentions: helperMocks.resolveMentions }));

import { addComment, getComments, editComment, removeComment } from "../services/commentService.js";
import * as commentRepo from "../repositories/comment.js";
import { getTaskById, getHabitatIdForTask } from "../repositories/task.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    taskId: "task-1",
    parentId: null,
    authorType: "human",
    authorId: "u1",
    content: "Hi",
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    ...overrides,
  };
}

describe("commentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helperMocks.resolveMentions.mockReturnValue([]);
    cmtMentionMocks.createMentions.mockReturnValue([]);
    vi.mocked(commentRepo.createComment).mockReturnValue(makeComment() as any);
    vi.mocked(commentRepo.getCommentById).mockReturnValue(null);
    vi.mocked(commentRepo.getCommentsByTaskId).mockReturnValue({ comments: [], total: 0 });
    vi.mocked(commentRepo.updateComment).mockReturnValue(null);
    vi.mocked(commentRepo.deleteComment).mockReturnValue(true);
    vi.mocked(getTaskById).mockReturnValue(null);
    vi.mocked(getHabitatIdForTask).mockReturnValue(null);
  });

  describe("addComment", () => {
    it("throws when task not found", () => {
      vi.mocked(getTaskById).mockReturnValue(null);
      expect(() => addComment("t1", "human", "u1", "Hi")).toThrow("Task not found");
    });

    it("throws when parent comment not found", () => {
      vi.mocked(getTaskById).mockReturnValue({ id: "t1" } as any);
      expect(() => addComment("t1", "human", "u1", "Reply", "missing")).toThrow(
        "Parent comment not found",
      );
    });

    it("throws when parent comment belongs to different task", () => {
      vi.mocked(getTaskById).mockReturnValue({ id: "t1" } as any);
      vi.mocked(commentRepo.getCommentById).mockReturnValue(makeComment({ taskId: "t2" }) as any);
      expect(() => addComment("t1", "human", "u1", "Nope", "p1")).toThrow(
        "Parent comment belongs to a different task",
      );
    });

    it("creates comment and broadcasts", () => {
      vi.mocked(getTaskById).mockReturnValue({ id: "t1" } as any);
      vi.mocked(getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(commentRepo.createComment).mockReturnValue(makeComment({ id: "new-c" }) as any);

      const result = addComment("t1", "human", "u1", "Hello");

      expect(result.id).toBe("new-c");
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({ type: "task.commented" }),
      );
    });

    it("handles mentions", () => {
      vi.mocked(getTaskById).mockReturnValue({ id: "t1" } as any);
      vi.mocked(getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(commentRepo.createComment).mockReturnValue(makeComment({ id: "c1" }) as any);
      helperMocks.resolveMentions.mockReturnValue([
        { mentionedType: "human", mentionedId: "u2", mentionText: "@bob", mentionedName: "bob" },
      ]);
      cmtMentionMocks.createMentions.mockReturnValue([
        {
          id: "m1",
          commentId: "c1",
          mentionedType: "human",
          mentionedId: "u2",
          mentionText: "@bob",
          createdAt: "2025-01-01",
        },
      ] as any);

      addComment("t1", "human", "u1", "Hey @bob");

      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({ type: "task.mentioned" }),
      );
    });
  });

  describe("getComments", () => {
    it("delegates", () => {
      vi.mocked(commentRepo.getCommentsByTaskId).mockReturnValue({
        comments: [makeComment() as any],
        total: 1,
      });
      expect(getComments("t1").total).toBe(1);
    });
  });

  describe("editComment", () => {
    it("throws when not found", () => {
      expect(() => editComment("c1", "human", "u1", "x")).toThrow("Comment not found");
    });

    it("throws when not authorized", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(
        makeComment({ authorType: "agent", authorId: "a2" }) as any,
      );
      expect(() => editComment("c1", "human", "u1", "x")).toThrow("Not authorized");
    });

    it("updates when authorized", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(makeComment() as any);
      vi.mocked(commentRepo.updateComment).mockReturnValue(makeComment({ content: "New" }) as any);
      expect(editComment("c1", "human", "u1", "New")!.content).toBe("New");
    });
  });

  describe("removeComment", () => {
    it("throws when not found", () => {
      expect(() => removeComment("c1", "human", "u1")).toThrow("Comment not found");
    });

    it("throws when not authorized", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(
        makeComment({ authorType: "agent" }) as any,
      );
      expect(() => removeComment("c1", "human", "u1")).toThrow("Not authorized");
    });

    it("deletes and broadcasts", () => {
      vi.mocked(commentRepo.getCommentById).mockReturnValue(makeComment() as any);
      vi.mocked(getTaskById).mockReturnValue({ id: "t1" } as any);
      vi.mocked(getHabitatIdForTask).mockReturnValue("h1");
      expect(removeComment("c1", "human", "u1")).toBe(true);
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({ type: "task.comment_deleted" }),
      );
    });
  });
});
