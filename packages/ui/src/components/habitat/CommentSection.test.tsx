import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommentSection } from "./CommentSection.js";

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();
const mockInvalidateQueries = vi.fn();

let mockAgents: Array<{ id: string; name: string }> = [];

vi.mock("../../api/index.js", () => ({
  api: {
    comments: {
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
  },
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock("../../lib/useHabitatData.js", () => ({
  useAgents: () => ({ data: mockAgents }),
}));

vi.mock("../../lib/queryKeys.js", () => ({
  queryKeys: {
    tasks: {
      comments: (taskId: string) => ["tasks", "comments", taskId],
    },
  },
}));

vi.mock("../ui/MarkdownContent.js", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

vi.mock("../../lib/commentMentions.js", () => ({
  injectMentionLinks: (content: string) => content,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: (...args: unknown[]) => mockInvalidateQueries(...args),
    }),
  };
});

function makeComment(overrides: Partial<{
  id: string;
  taskId: string;
  parentId: string | null;
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}> = {}) {
  return {
    id: "comment-1",
    taskId: "task-1",
    parentId: null,
    authorType: "human" as const,
    authorId: "user-1",
    content: "Existing comment body",
    createdAt: "2026-01-01T10:00:00Z",
    updatedAt: "2026-01-01T10:00:00Z",
    ...overrides,
  };
}

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("CommentSection — empty state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgents = [];
  });
  afterEach(() => cleanup());

  it("shows the empty state when there are no comments", () => {
    renderWithQC(<CommentSection taskId="task-1" />);
    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
  });

  it("shows the comment composer even when there are no comments", () => {
    renderWithQC(<CommentSection taskId="task-1" />);
    expect(screen.getByPlaceholderText("Add a comment...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Post/i })).toBeInTheDocument();
  });

  it("does not show the empty state when comments are provided", () => {
    renderWithQC(
      <CommentSection taskId="task-1" initialComments={[makeComment()]} />,
    );
    expect(screen.queryByText("No comments yet.")).toBeNull();
  });
});

describe("CommentSection — renders existing comments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgents = [];
  });
  afterEach(() => cleanup());

  it("renders the comment body", () => {
    renderWithQC(
      <CommentSection taskId="task-1" initialComments={[makeComment({ content: "Hello world" })]} />,
    );
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders the comment count badge in the title", () => {
    renderWithQC(
      <CommentSection
        taskId="task-1"
        initialComments={[
          makeComment({ id: "c1", content: "First" }),
          makeComment({ id: "c2", content: "Second" }),
        ]}
      />,
    );
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders the Comments title", () => {
    renderWithQC(
      <CommentSection taskId="task-1" initialComments={[makeComment()]} />,
    );
    expect(screen.getByText("Comments")).toBeInTheDocument();
  });

  it("does not show the count badge when there are no comments", () => {
    renderWithQC(<CommentSection taskId="task-1" />);
    // The Comments title is still shown.
    expect(screen.getByText("Comments")).toBeInTheDocument();
    // The badge with count is not shown.
    expect(screen.queryByText("1")).toBeNull();
  });
});

describe("CommentSection — add comment flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgents = [];
  });
  afterEach(() => cleanup());

  it("disables Post button when content is empty", () => {
    renderWithQC(<CommentSection taskId="task-1" />);
    const postBtn = screen.getByRole("button", { name: /Post/i });
    expect(postBtn).toBeDisabled();
  });

  it("enables Post button when content is non-empty", () => {
    renderWithQC(<CommentSection taskId="task-1" />);
    const textarea = screen.getByPlaceholderText("Add a comment...");
    fireEvent.change(textarea, { target: { value: "A new comment" } });
    const postBtn = screen.getByRole("button", { name: /Post/i });
    expect(postBtn).not.toBeDisabled();
  });

  it("calls api.comments.create with the typed content", async () => {
    mockCreate.mockResolvedValue({
      comment: makeComment({ id: "new-comment", content: "A new comment" }),
    });
    renderWithQC(<CommentSection taskId="task-1" />);
    const textarea = screen.getByPlaceholderText("Add a comment...");
    fireEvent.change(textarea, { target: { value: "A new comment" } });
    fireEvent.click(screen.getByRole("button", { name: /Post/i }));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
    expect(mockCreate).toHaveBeenCalledWith("task-1", {
      content: "A new comment",
      parentId: undefined,
    });
  });

  it("appends the new comment to the list after creation", async () => {
    mockCreate.mockResolvedValue({
      comment: makeComment({
        id: "new-comment",
        content: "Just added",
        createdAt: "2026-02-01T10:00:00Z",
        updatedAt: "2026-02-01T10:00:00Z",
      }),
    });
    renderWithQC(
      <CommentSection
        taskId="task-1"
        initialComments={[makeComment({ id: "existing", content: "Existing comment" })]}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Add a comment..."), {
      target: { value: "Just added" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Post/i }));
    await waitFor(() => {
      expect(screen.getByText("Just added")).toBeInTheDocument();
    });
  });

  it("clears the textarea after successful submission", async () => {
    mockCreate.mockResolvedValue({
      comment: makeComment({ id: "new", content: "Hi" }),
    });
    renderWithQC(<CommentSection taskId="task-1" />);
    const textarea = screen.getByPlaceholderText("Add a comment...") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: /Post/i }));
    await waitFor(() => {
      expect(textarea.value).toBe("");
    });
  });

  it("invalidates the comments query after success", async () => {
    mockCreate.mockResolvedValue({
      comment: makeComment({ id: "new", content: "Hi" }),
    });
    renderWithQC(<CommentSection taskId="task-1" />);
    fireEvent.change(screen.getByPlaceholderText("Add a comment..."), {
      target: { value: "Hi" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Post/i }));
    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ["tasks", "comments", "task-1"],
      });
    });
  });

  it("shows success toast on successful add", async () => {
    mockCreate.mockResolvedValue({
      comment: makeComment({ id: "new", content: "Hi" }),
    });
    renderWithQC(<CommentSection taskId="task-1" />);
    fireEvent.change(screen.getByPlaceholderText("Add a comment..."), {
      target: { value: "Hi" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Post/i }));
    await waitFor(() => {
      expect(mockNotifySuccess).toHaveBeenCalledWith("Comment added");
    });
  });

  it("shows error toast when create fails", async () => {
    mockCreate.mockRejectedValue(new Error("Network down"));
    renderWithQC(<CommentSection taskId="task-1" />);
    fireEvent.change(screen.getByPlaceholderText("Add a comment..."), {
      target: { value: "Will fail" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Post/i }));
    await waitFor(() => {
      expect(mockNotifyError).toHaveBeenCalledWith("Network down");
    });
  });

  it("does not submit when content is whitespace-only", async () => {
    renderWithQC(<CommentSection taskId="task-1" />);
    fireEvent.change(screen.getByPlaceholderText("Add a comment..."), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Post/i }));
    // Wait a tick — no API call expected.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockCreate).not.toHaveBeenCalled();
  });
});