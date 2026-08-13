import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CommunicationFeedItemView } from "./CommunicationFeedItem.js";
import type { CommunicationFeedItem } from "./mergeCommunicationFeed.js";
import type { MissionComment } from "../../types/index.js";

vi.mock("./PulseSignalCard.js", () => ({
  PulseSignalCard: ({ pulse }: { pulse: { subject: string } }) => <div>{pulse.subject}</div>,
}));

vi.mock("./PulseReplyThread.js", () => ({
  PulseReplyThread: () => null,
}));

function commentItem(authorType: MissionComment["authorType"]): CommunicationFeedItem {
  return {
    kind: "comment",
    createdAt: "2026-08-13T12:00:00.000Z",
    comment: {
      id: "c1",
      missionId: "m1",
      parentId: null,
      authorType,
      authorId: "abcd1234ffff",
      content: "note",
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    },
  };
}

describe("CommunicationFeedItemView", () => {
  it("does not label a remote orcy as Human", () => {
    render(<CommunicationFeedItemView item={commentItem("remote_orcy")} missionId="m1" />);
    expect(screen.getByText(/Remote Or: abcd1234/)).toBeInTheDocument();
    expect(screen.queryByText(/^Human$/)).not.toBeInTheDocument();
    expect(screen.getByText("Comment")).toBeInTheDocument();
  });
});
