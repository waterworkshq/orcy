import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { MissionCommunicationBoard } from "./MissionCommunicationBoard.js";
import type { MissionComment, Pulse } from "../../types/index.js";

const listByMission = vi.fn();
const listComments = vi.fn();
const me = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    auth: { me: (...args: unknown[]) => me(...args) },
    pulse: { listByMission: (...args: unknown[]) => listByMission(...args) },
    missionComments: {
      list: (...args: unknown[]) => listComments(...args),
      create: vi.fn(),
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
      comments: [comment({ id: "c1", createdAt: "2026-08-13T11:00:00.000Z", content: "ship the fix" })],
      total: 1,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hides auto Pulse by default and interleaves comments without calling them Pulse", async () => {
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
    expect(screen.getByText("Post Signal")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/comment/i)).toBeInTheDocument();
    expect(screen.queryByText(/chat/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/activity feed/i)).not.toBeInTheDocument();
  });

  it("can show comments only", async () => {
    renderBoard();
    expect(await screen.findByText("retry failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^comments$/i }));
    expect(screen.queryByText("retry failed")).not.toBeInTheDocument();
    expect(screen.getByText("ship the fix")).toBeInTheDocument();
  });
});
