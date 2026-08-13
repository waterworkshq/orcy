import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { MissionCommentCard } from "./MissionCommentCard.js";
import type { MissionComment } from "../../types/index.js";

const updateComment = vi.fn();
const deleteComment = vi.fn();
const createComment = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    missionComments: {
      update: (...args: unknown[]) => updateComment(...args),
      delete: (...args: unknown[]) => deleteComment(...args),
      create: (...args: unknown[]) => createComment(...args),
    },
  },
}));

function comment(partial?: Partial<MissionComment>): MissionComment {
  return {
    id: "c1",
    missionId: "m1",
    parentId: null,
    authorType: "human",
    authorId: "u1",
    content: "ship the fix",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
    ...partial,
  };
}

function renderCard(value: MissionComment = comment()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MissionCommentCard missionId="m1" comment={value} />
    </QueryClientProvider>,
  );
}

describe("MissionCommentCard", () => {
  beforeEach(() => {
    updateComment.mockResolvedValue({ comment: comment({ content: "shipped" }) });
    deleteComment.mockResolvedValue(undefined);
    createComment.mockResolvedValue({
      comment: comment({ id: "c2", content: "ack", parentId: "c1" }),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("edits and deletes a comment", async () => {
    renderCard();
    expect(screen.getByText("ship the fix")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(screen.getByDisplayValue("ship the fix"), { target: { value: "shipped" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      expect(updateComment).toHaveBeenCalledWith("m1", "c1", { content: "shipped" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => {
      expect(deleteComment).toHaveBeenCalledWith("m1", "c1");
    });
  });

  it("replies with parentId", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Reply to comment" }));
    fireEvent.change(screen.getByPlaceholderText(/write a reply/i), { target: { value: "ack" } });
    fireEvent.click(screen.getByRole("button", { name: /^reply$/i }));
    await waitFor(() => {
      expect(createComment).toHaveBeenCalledWith("m1", { content: "ack", parentId: "c1" });
    });
  });
});
