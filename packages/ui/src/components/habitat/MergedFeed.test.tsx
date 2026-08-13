import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MergedFeed } from "./MergedFeed.js";
import type { CommunicationFeedItem } from "./mergeCommunicationFeed.js";
import type { Pulse } from "../../types/index.js";

vi.mock("./CommunicationFeedItem.js", () => ({
  CommunicationFeedItemView: ({ item }: { item: CommunicationFeedItem }) =>
    item.kind === "pulse" ? <div>{item.pulse.subject}</div> : <div>{item.comment.content}</div>,
}));

function pulseItem(subject: string): CommunicationFeedItem {
  return {
    kind: "pulse",
    createdAt: "2026-08-13T12:00:00.000Z",
    pulse: { id: "p1", subject } as Pulse,
  };
}

describe("MergedFeed", () => {
  it("shows empty copy when there are no items", () => {
    render(
      <MergedFeed
        items={[]}
        isLoading={false}
        missionId="m1"
        hasMore={false}
        onLoadMore={() => undefined}
        loadingMore={false}
        emptyTitle="No Pulse signals or comments yet"
      />,
    );
    expect(screen.getByText("No Pulse signals or comments yet")).toBeInTheDocument();
  });

  it("loads more when asked", () => {
    const onLoadMore = vi.fn();
    render(
      <MergedFeed
        items={[pulseItem("retry failed")]}
        isLoading={false}
        missionId="m1"
        hasMore
        onLoadMore={onLoadMore}
        loadingMore={false}
        emptyTitle="empty"
      />,
    );
    expect(screen.getByText("retry failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    expect(onLoadMore).toHaveBeenCalled();
  });
});
