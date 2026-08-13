import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { MissionCommunicationBoard } from "./MissionCommunicationBoard.js";
import type { MissionComment, Pulse } from "../../types/index.js";

const listByMission = vi.fn();
const listComments = vi.fn();
const createComment = vi.fn();
const me = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    auth: { me: (...args: unknown[]) => me(...args) },
    pulse: { listByMission: (...args: unknown[]) => listByMission(...args) },
    missionComments: {
      list: (...args: unknown[]) => listComments(...args),
      create: (...args: unknown[]) => createComment(...args),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("./PulseComposeDialog.js", () => ({
  PulseComposeDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="pulse-compose-dialog" /> : null,
}));

vi.mock("./PulseSignalCard.js", () => ({
  PulseSignalCard: ({ pulse }: { pulse: Pulse }) => <div>{pulse.subject}</div>,
}));

vi.mock("./PulseReplyThread.js", () => ({
  PulseReplyThread: () => null,
}));

function pulse(partial: Pick<Pulse, "id" | "createdAt" | "subject">): Pulse {
  return {
    missionId: "m1",
    habitatId: "h1",
    scope: "mission",
    fromType: "human",
    fromId: "u1",
    toType: null,
    toId: null,
    signalType: "finding",
    body: "body",
    taskId: null,
    replyToId: null,
    linkedTaskId: null,
    metadata: {},
    pinned: 0,
    isAuto: false,
    ...partial,
  };
}

function comment(partial: Pick<MissionComment, "id" | "createdAt" | "content">): MissionComment {
  return {
    missionId: "m1",
    authorType: "human",
    authorId: "u1",
    parentId: null,
    updatedAt: partial.createdAt,
    ...partial,
  };
}

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MissionCommunicationBoard missionId="m1" />
    </QueryClientProvider>,
  );
}

describe("MissionCommunicationBoard", () => {
  beforeEach(() => {
    me.mockResolvedValue({ user: { id: "u1", username: "ada", role: "editor" } });
    listByMission.mockResolvedValue({
      items: [pulse({ id: "p1", createdAt: "2026-08-13T12:00:00.000Z", subject: "retry failed" })],
      total: 1,
    });
    listComments.mockResolvedValue({
      comments: [
        comment({ id: "c1", createdAt: "2026-08-13T11:00:00.000Z", content: "ship the fix" }),
      ],
      total: 1,
    });
    createComment.mockResolvedValue({
      comment: comment({ id: "c2", createdAt: "2026-08-13T13:00:00.000Z", content: "new note" }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hides auto Pulse by default and interleaves comments", async () => {
    renderBoard();
    await waitFor(() => {
      expect(listByMission).toHaveBeenCalledWith(
        "m1",
        expect.objectContaining({ isAuto: "false" }),
      );
    });
    expect(await screen.findByText("retry failed")).toBeInTheDocument();
    expect(screen.getByText("ship the fix")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /communication/i })).toBeInTheDocument();
    expect(screen.getByText(/advisory feedback/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/comment/i)).toBeInTheDocument();
    expect(screen.getByText("Post Signal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit comment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeInTheDocument();
  });

  it("posts a comment from All and keeps Pulse-only mode without a comment composer", async () => {
    renderBoard();
    const box = await screen.findByPlaceholderText(/comment/i);
    fireEvent.change(box, { target: { value: "new note" } });
    fireEvent.click(screen.getByRole("button", { name: /post comment/i }));
    await waitFor(() => {
      expect(createComment).toHaveBeenCalledWith("m1", { content: "new note" });
    });

    fireEvent.click(screen.getByRole("button", { name: /^pulse$/i }));
    expect(screen.getByText("retry failed")).toBeInTheDocument();
    expect(screen.queryByText("ship the fix")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/comment/i)).not.toBeInTheDocument();
    expect(screen.getByText("Post Signal")).toBeInTheDocument();
  });

  it("shows empty copy when both lists are empty", async () => {
    listByMission.mockResolvedValue({ items: [], total: 0 });
    listComments.mockResolvedValue({ comments: [], total: 0 });
    renderBoard();
    expect(await screen.findByText("No Pulse signals or comments yet")).toBeInTheDocument();
  });

  it("offers load more when another Pulse page exists", async () => {
    listByMission.mockResolvedValue({
      items: Array.from({ length: 20 }, (_, i) =>
        pulse({
          id: `p${i}`,
          createdAt: "2026-08-13T12:00:00.000Z",
          subject: i === 0 ? "retry failed" : `signal ${i}`,
        }),
      ),
      total: 21,
    });
    renderBoard();
    expect(await screen.findByRole("button", { name: /load more/i })).toBeInTheDocument();
  });

  it("offers load more when another Comments page exists", async () => {
    listComments.mockResolvedValue({
      comments: Array.from({ length: 50 }, (_, i) =>
        comment({
          id: `c${i}`,
          createdAt: "2026-08-13T11:00:00.000Z",
          content: `comment ${i}`,
        }),
      ),
      total: 51,
    });
    renderBoard();
    const loadMoreBtn = await screen.findByRole("button", { name: /load more/i });
    expect(loadMoreBtn).toBeInTheDocument();

    fireEvent.click(loadMoreBtn);
    await waitFor(() => {
      expect(listComments).toHaveBeenCalledWith("m1", { limit: 50, offset: 50 });
    });
  });

  it("renders error message and retry button when query fails, and retries on click", async () => {
    listByMission.mockRejectedValue(new Error("Network connection lost"));
    renderBoard();

    expect(await screen.findByText("Network connection lost")).toBeInTheDocument();
    expect(screen.queryByText("No Pulse signals or comments yet")).not.toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    expect(retryBtn).toBeInTheDocument();

    listByMission.mockResolvedValue({
      items: [pulse({ id: "p1", createdAt: "2026-08-13T12:00:00.000Z", subject: "retry succeeded" })],
      total: 1,
    });

    fireEvent.click(retryBtn);
    expect(await screen.findByText("retry succeeded")).toBeInTheDocument();
  });
});

