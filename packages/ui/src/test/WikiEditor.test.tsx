import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { startTransition, useLayoutEffect, useState } from "react";
import { toast } from "sonner";
import { WikiEditor } from "../components/wiki/WikiEditor.js";
import { queryKeys } from "../lib/queryKeys.js";
import { wikiApi } from "../api/domains/wiki.js";

// Only the HTTP API boundary is replaced: editor, child panels, mutations and cache are real.
vi.mock("../api/domains/wiki.js", () => ({
  wikiApi: {
    getPage: vi.fn(), listPages: vi.fn(), saveVersion: vi.fn(),
    updatePageMetadata: vi.fn(), createPage: vi.fn(),
    listLinks: vi.fn(), addLink: vi.fn(), removeLink: vi.fn(),
    getAuthoringContextForEdit: vi.fn(), getAuthoringContextForChunk: vi.fn(),
  },
}));

type Page = Awaited<ReturnType<typeof wikiApi.getPage>>;
let page: Page;
let client: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  page = {
    id: "p", habitatId: "h", title: "Server title", content: "Server body",
    parentId: null, tags: [], status: "draft", links: [],
    slug: "server-title", currentVersionNumber: 1, createdBy: "author", lastUpdatedBy: "author",
    lastUpdatedAt: "2026-10-17T00:00:00Z",
    createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z",
  };
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(wikiApi.getPage).mockImplementation(async () => structuredClone(page));
  vi.mocked(wikiApi.listPages).mockResolvedValue([]);
  vi.mocked(wikiApi.listLinks).mockResolvedValue([]);
  vi.mocked(wikiApi.getAuthoringContextForEdit).mockResolvedValue({});
  vi.mocked(wikiApi.getAuthoringContextForChunk).mockResolvedValue({});
  vi.mocked(wikiApi.updatePageMetadata).mockImplementation(async (_h, _p, input) => {
    page = { ...page, ...input };
    return structuredClone(page);
  });
  vi.mocked(wikiApi.saveVersion).mockImplementation(async (_h, _p, input) => {
    page = { ...page, title: input.title, content: input.content };
    return structuredClone(page);
  });
});

afterEach(() => { cleanup(); client.clear(); });

function editor(habitatId = "h", pageId = "p") {
  return <QueryClientProvider client={client}>
    <WikiEditor habitatId={habitatId} mode="edit" pageId={pageId} onDone={() => {}} onCancel={() => {}} />
  </QueryClientProvider>;
}
const body = () => screen.getByPlaceholderText("Write page content in markdown…");
const title = () => screen.getByPlaceholderText("Page title…");
function change(input: HTMLElement, value: string) { fireEvent.change(input, { target: { value } }); }

describe("WikiEditor draft lifecycle", () => {
  it("saves metadata independently while preserving unsaved title and body", async () => {
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(title(), "Unsaved title");
    change(body(), "UNSAVED IMPORTANT BODY");
    change(screen.getByRole("combobox", { name: "Status" }), "published");
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save metadata" })).not.toBeInTheDocument());
    expect(wikiApi.updatePageMetadata).toHaveBeenCalledWith("h", "p", { parentId: null, tags: [], status: "published" });
    expect(wikiApi.saveVersion).not.toHaveBeenCalled();
    expect(title()).toHaveValue("Unsaved title");
    expect(body()).toHaveValue("UNSAVED IMPORTANT BODY");
    expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled();
  });
  it("keeps metadata typed after submission even when a refetch observes the pending write", async () => {
    let finish!: (value: Page) => void;
    vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(screen.getByRole("combobox", { name: "Status" }), "published");
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() => expect(wikiApi.updatePageMetadata).toHaveBeenCalledTimes(1));
    change(screen.getByRole("combobox", { name: "Status" }), "draft");
    page = { ...page, status: "published", title: "Refetched title" };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    await screen.findByDisplayValue("Refetched title");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("draft");
    await act(async () => finish(structuredClone(page)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save metadata" })).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("draft");
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save metadata" })).not.toBeInTheDocument());
    expect(wikiApi.updatePageMetadata).toHaveBeenLastCalledWith("h", "p", { parentId: null, tags: [], status: "draft" });
  });

  it("acknowledges only submitted text and retains later edits and unsaved metadata", async () => {
    let finish!: (value: Page) => void;
    vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(title(), "  New title  ");
    change(body(), "First body");
    change(screen.getByPlaceholderText("Briefly describe this change…"), "First summary");
    change(screen.getByRole("combobox", { name: "Status" }), "published");
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(1));
    expect(wikiApi.saveVersion).toHaveBeenCalledWith("h", "p", { title: "New title", content: "First body", editSummary: "First summary" });
    change(body(), "Later body");
    change(screen.getByPlaceholderText("Briefly describe this change…"), "Later summary");
    page = { ...page, title: "New title", content: "First body" };
    await act(async () => finish(structuredClone(page)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled());
    expect(title()).toHaveValue("New title");
    expect(body()).toHaveValue("Later body");
    expect(screen.getByPlaceholderText("Briefly describe this change…")).toHaveValue("Later summary");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
    expect(screen.getByRole("button", { name: "Save metadata" })).toBeEnabled();
  });

  it("refreshes clean fields and asks before saving a remotely changed dirty field", async () => {
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(title(), "My draft title");
    page = { ...page, title: "Remote title", content: "Remote body", status: "published" };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    await screen.findByDisplayValue("Remote body");
    expect(title()).toHaveValue("My draft title");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
    await screen.findByText("Title changed on the server.");
    expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my Title" }));
    expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled();
    page = { ...page, title: "Another remote title" };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    fireEvent.click(await screen.findByRole("button", { name: "Use server Title" }));
    expect(title()).toHaveValue("Another remote title");
    expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
  });

  it("starts a fresh draft for a different Habitat and page while an old save is pending", async () => {
    let finish!: (value: Page) => void;
    vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(editor());
    await screen.findByDisplayValue("Server body");
    change(title(), "Old pending title");
    change(screen.getByRole("combobox", { name: "Status" }), "published");
    change(screen.getByPlaceholderText("Briefly describe this change…"), "Old summary");
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(1));
    const old = { ...page, title: "Old pending title" };
    page = { ...page, id: "p2", habitatId: "h2", title: "Other title", content: "Other body" };
    view.rerender(editor("h2", "p2"));
    await screen.findByDisplayValue("Other body");
    expect(title()).toHaveValue("Other title");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("draft");
    expect(screen.getByPlaceholderText("Briefly describe this change…")).toHaveValue("");
    await act(async () => finish(old));
    expect(title()).toHaveValue("Other title");
    expect(body()).toHaveValue("Other body");
    expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
  });

  it("does not navigate from a create response after the editor identity has changed", async () => {
    let finish!: (value: Page) => void;
    const onDone = vi.fn();
    vi.mocked(wikiApi.createPage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<QueryClientProvider client={client}>
      <WikiEditor habitatId="h" mode="create" onDone={onDone} onCancel={() => {}} />
    </QueryClientProvider>);
    change(title(), "New page");
    change(body(), "New body");
    fireEvent.click(screen.getByRole("button", { name: "Create page" }));
    await waitFor(() => expect(wikiApi.createPage).toHaveBeenCalledTimes(1));
    view.rerender(editor());
    await screen.findByDisplayValue("Server body");
    await act(async () => finish({ ...page, id: "created" }));
    expect(onDone).not.toHaveBeenCalled();
    expect(body()).toHaveValue("Server body");
  });

  it("preserves dirty fields across actual citation add and remove invalidations", async () => {
    type Link = Awaited<ReturnType<typeof wikiApi.listLinks>>[number];
    let links: Link[] = [];
    vi.mocked(wikiApi.listLinks).mockImplementation(async () => structuredClone(links));
    vi.mocked(wikiApi.addLink).mockImplementation(async (_h, _p, input) => {
      const link: Link = { id: "link", pageId: "p", targetType: input.targetType, targetId: input.targetId,
        linkNote: null, createdBy: "author", createdAt: "2026-10-17T00:00:00Z", dangling: false };
      links = [link];
      return link;
    });
    vi.mocked(wikiApi.removeLink).mockImplementation(async () => { links = []; return { success: true }; });
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(title(), "My title");
    change(body(), "My body");
    change(screen.getByRole("combobox", { name: "Status" }), "published");
    change(screen.getByPlaceholderText("Add tag…"), "my-tag");
    fireEvent.keyDown(screen.getByPlaceholderText("Add tag…"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    change(screen.getByPlaceholderText("Target ID…"), "task-1");
    fireEvent.click(screen.getByRole("button", { name: "Add citation" }));
    await screen.findByText("task-1");
    await waitFor(() => expect(wikiApi.getPage).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Remove citation" }));
    await screen.findByText("No citations yet.");
    await waitFor(() => expect(wikiApi.getPage).toHaveBeenCalledTimes(3));
    expect(title()).toHaveValue("My title");
    expect(body()).toHaveValue("My body");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
    expect(screen.getByText("#my-tag")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save metadata" })).toBeEnabled();
  });

  it("retains draft fields and summaries after failed saves", async () => {
    vi.mocked(wikiApi.updatePageMetadata).mockRejectedValueOnce(new Error("Metadata rejected"));
    vi.mocked(wikiApi.saveVersion).mockRejectedValueOnce(new Error("Version rejected"));
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(title(), "My title");
    change(body(), "My body");
    change(screen.getByRole("combobox", { name: "Status" }), "published");
    change(screen.getByPlaceholderText("Briefly describe this change…"), "My summary");
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() => expect(wikiApi.updatePageMetadata).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save metadata" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await screen.findByText("Save failed");
    expect(title()).toHaveValue("My title");
    expect(body()).toHaveValue("My body");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
    expect(screen.getByPlaceholderText("Briefly describe this change…")).toHaveValue("My summary");
  });

  it("creates a page with the existing wire payload and completion callback", async () => {
    const onDone = vi.fn();
    vi.mocked(wikiApi.createPage).mockResolvedValueOnce({ ...page, id: "created" });
    render(<QueryClientProvider client={client}>
      <WikiEditor habitatId="h" mode="create" onDone={onDone} onCancel={() => {}} />
    </QueryClientProvider>);
    change(title(), "  New page  ");
    change(body(), "New body");
    change(screen.getByRole("combobox", { name: "Status" }), "published");
    fireEvent.click(screen.getByRole("button", { name: "Create page" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("created"));
    expect(wikiApi.createPage).toHaveBeenCalledWith("h", { title: "New page", content: "New body", parentId: null, tags: [], status: "published" });
  });

  it("blocks only metadata saves for a remotely changed dirty metadata field", async () => {
    vi.mocked(wikiApi.listPages).mockResolvedValue([{ ...page, id: "parent", title: "Parent" }]);
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(screen.getByRole("combobox", { name: "Parent page" }), "parent");
    change(title(), "My title");
    page = { ...page, parentId: "remote-parent" };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    await screen.findByText("Parent page changed on the server.");
    expect(screen.getByRole("button", { name: "Save metadata" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my Parent page" }));
    expect(screen.getByRole("button", { name: "Save metadata" })).toBeEnabled();
  });

  it("retains text typed back to the old baseline during a pending save and refetch", async () => {
    let finish!: (value: Page) => void;
    vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(body(), "Submitted body");
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(1));
    change(body(), "Server body");
    page = { ...page, content: "Submitted body", status: "published" };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published"));
    expect(body()).toHaveValue("Server body");
    await act(async () => finish(structuredClone(page)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled());
    expect(body()).toHaveValue("Server body");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([["h", "p2"], ["h2", "p"]])("resets drafts for independent identity changes to %s/%s", async (habitatId, pageId) => {
    const view = render(editor());
    await screen.findByDisplayValue("Server body");
    change(title(), "Old draft");
    page = { ...page, id: pageId, habitatId, title: "Fresh title", content: "Fresh body" };
    view.rerender(editor(habitatId, pageId));
    await screen.findByDisplayValue("Fresh body");
    expect(title()).toHaveValue("Fresh title");
    expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
  });

  it.each(["metadata", "text"] as const)("replays observed server changes after a pending %s save fails", async (group) => {
    let reject!: (error: Error) => void;
    if (group === "metadata") {
      vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    } else {
      vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    }
    vi.mocked(wikiApi.listPages).mockResolvedValue([{ ...page, id: "parent", title: "Parent" }]);
    vi.mocked(wikiApi.addLink).mockResolvedValue({ id: "link", pageId: "p", targetType: "task", targetId: "task-1",
      linkNote: null, createdBy: "author", createdAt: "2026-10-17T00:00:00Z", dangling: false });
    render(editor());
    await screen.findByDisplayValue("Server body");
    if (group === "metadata") {
      change(screen.getByRole("combobox", { name: "Status" }), "published");
      change(screen.getByPlaceholderText("Add tag…"), "mine");
      fireEvent.keyDown(screen.getByPlaceholderText("Add tag…"), { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
      await waitFor(() => expect(wikiApi.updatePageMetadata).toHaveBeenCalledTimes(1));
      page = { ...page, tags: ["remote"], parentId: "parent" };
    } else {
      change(title(), "My title");
      fireEvent.click(screen.getByRole("button", { name: "Save version" }));
      await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(1));
      page = { ...page, title: "Remote title", content: "Remote body" };
    }
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    change(screen.getByPlaceholderText("Target ID…"), "task-1");
    fireEvent.click(screen.getByRole("button", { name: "Add citation" }));
    await waitFor(() => expect(wikiApi.getPage).toHaveBeenCalledTimes(2));
    const observed = client.getQueryData(queryKeys.wiki.page("h", "p"));
    expect(observed).toEqual(page);
    await act(async () => reject(new Error("Write refused")));
    if (group === "metadata") {
      await screen.findByText("Tags changed on the server.");
      expect(screen.getByRole("combobox", { name: "Parent page" })).toHaveValue("parent");
      expect(screen.getByText("#mine")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save metadata" })).toBeDisabled();
    } else {
      await screen.findByText("Title changed on the server.");
      expect(title()).toHaveValue("My title");
      expect(body()).toHaveValue("Remote body");
      expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
    }
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    expect(client.getQueryData(queryKeys.wiki.page("h", "p"))).toBe(observed);
    expect(screen.getByRole("button", { name: group === "metadata" ? "Save metadata" : "Save version" })).toBeDisabled();
  });

  it("uses an already observed clean remote metadata field when retrying a failed save", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(screen.getByRole("combobox", { name: "Status" }), "published");
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() => expect(wikiApi.updatePageMetadata).toHaveBeenCalledTimes(1));
    page = { ...page, tags: ["remote"] };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    await act(async () => reject(new Error("Write refused")));
    await screen.findByText("#remote");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() => expect(wikiApi.updatePageMetadata).toHaveBeenCalledTimes(2));
    expect(wikiApi.updatePageMetadata).toHaveBeenLastCalledWith("h", "p", { parentId: null, tags: ["remote"], status: "published" });
  });

  it.each(["text", "metadata"] as const)("keeps acknowledged %s when the other save fails before its refetch completes", async (acknowledged) => {
    let acknowledge!: (value: Page) => void;
    let reject!: (error: Error) => void;
    let finishRead!: (value: Page) => void;
    if (acknowledged === "text") {
      vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
      vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    } else {
      vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
      vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    }
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(body(), "Acknowledged body");
    change(screen.getByRole("combobox", { name: "Status" }), "published");
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(wikiApi.updatePageMetadata).toHaveBeenCalledTimes(1));
    vi.mocked(wikiApi.getPage).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    page = acknowledged === "text" ? { ...page, content: "Acknowledged body" } : { ...page, status: "published" };
    await act(async () => acknowledge(structuredClone(page)));
    await waitFor(() => expect(wikiApi.getPage).toHaveBeenCalledTimes(2));
    await act(async () => reject(new Error("Other write refused")));
    await waitFor(() => expect(screen.getByRole("button", { name: acknowledged === "text" ? "Save metadata" : "Save version" })).toBeEnabled());
    expect(body()).toHaveValue("Acknowledged body");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
    if (acknowledged === "text") expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
    else expect(screen.queryByRole("button", { name: "Save metadata" })).not.toBeInTheDocument();
    await act(async () => finishRead(structuredClone(page)));
    expect(body()).toHaveValue("Acknowledged body");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
  });

  it.each([
    ["text", false], ["text", true], ["metadata", false], ["metadata", true],
  ] as const)("reconciles an observed remote %s change after success while retaining later edits: %s", async (group, laterEdit) => {
    let finish!: (value: Page) => void;
    if (group === "text") vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    else vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    let acknowledged: Page;
    if (group === "text") {
      change(title(), "  Saved title  ");
      change(body(), "Submitted body");
      fireEvent.click(screen.getByRole("button", { name: "Save version" }));
      await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(1));
      acknowledged = { ...page, title: "Saved title", content: "Submitted body", currentVersionNumber: 2 };
      if (laterEdit) change(body(), "Later body");
      page = { ...acknowledged, content: "Remote body", currentVersionNumber: 3, status: "published" };
    } else {
      change(screen.getByPlaceholderText("Add tag…"), "submitted");
      fireEvent.keyDown(screen.getByPlaceholderText("Add tag…"), { key: "Enter" });
      change(screen.getByRole("combobox", { name: "Status" }), "published");
      fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
      await waitFor(() => expect(wikiApi.updatePageMetadata).toHaveBeenCalledTimes(1));
      acknowledged = { ...page, tags: ["submitted"], status: "published" };
      if (laterEdit) {
        change(screen.getByPlaceholderText("Add tag…"), "later");
        fireEvent.keyDown(screen.getByPlaceholderText("Add tag…"), { key: "Enter" });
      }
      page = { ...acknowledged, tags: ["remote"], content: "Observed remote body" };
    }
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    if (group === "text") await waitFor(() => expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published"));
    else await screen.findByDisplayValue("Observed remote body");
    const observed = client.getQueryData(queryKeys.wiki.page("h", "p"));
    expect(observed).toEqual(page);
    await act(async () => finish(structuredClone(acknowledged)));
    await screen.findByText(group === "text" ? "Content changed on the server." : "Tags changed on the server.");
    if (group === "text") {
      expect(title()).toHaveValue("Saved title");
      expect(body()).toHaveValue(laterEdit ? "Later body" : "Submitted body");
    } else {
      expect(screen.getByText("#submitted")).toBeInTheDocument();
      if (laterEdit) expect(screen.getByText("#later")).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
    }
    expect(screen.getByRole("button", { name: group === "text" ? "Save version" : "Save metadata" })).toBeDisabled();
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    expect(client.getQueryData(queryKeys.wiki.page("h", "p"))).toBe(observed);
    fireEvent.click(screen.getByRole("button", { name: group === "text" ? "Keep my Content" : "Keep my Tags" }));
    expect(screen.getByRole("button", { name: group === "text" ? "Save version" : "Save metadata" })).toBeEnabled();
  });

  it.each(["text", "metadata"] as const)("does not replace acknowledged %s with an unchanged pre-write cache", async (group) => {
    let finish!: (value: Page) => void;
    let finishRead!: (value: Page) => void;
    if (group === "text") vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    else vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    if (group === "text") {
      change(body(), "Acknowledged body");
      fireEvent.click(screen.getByRole("button", { name: "Save version" }));
      await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(1));
    } else {
      change(screen.getByRole("combobox", { name: "Status" }), "published");
      fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
      await waitFor(() => expect(wikiApi.updatePageMetadata).toHaveBeenCalledTimes(1));
    }
    const oldCache = client.getQueryData(queryKeys.wiki.page("h", "p"));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    expect(client.getQueryData(queryKeys.wiki.page("h", "p"))).toBe(oldCache);
    vi.mocked(wikiApi.getPage).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    page = group === "text" ? { ...page, content: "Acknowledged body", currentVersionNumber: 2 } : { ...page, status: "published" };
    await act(async () => finish(structuredClone(page)));
    await waitFor(() => expect(wikiApi.getPage).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    if (group === "text") {
      expect(body()).toHaveValue("Acknowledged body");
      expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
    } else {
      expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
      expect(screen.queryByRole("button", { name: "Save metadata" })).not.toBeInTheDocument();
    }
    await act(async () => finishRead(structuredClone(page)));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the acknowledged text baseline when a pending read saw an older version with a later timestamp", async () => {
    let finish!: (value: Page) => void;
    let finishRead!: (value: Page) => void;
    vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    change(body(), "Acknowledged body");
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(1));
    const acknowledged = { ...page, content: "Acknowledged body", currentVersionNumber: 3, updatedAt: "2026-10-17T00:00:02Z" };
    page = { ...page, content: "Intermediate body", currentVersionNumber: 2,
      updatedAt: "2026-10-17T00:00:03Z", status: "published" };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published"));
    expect(client.getQueryData(queryKeys.wiki.page("h", "p"))).toEqual(page);
    vi.mocked(wikiApi.getPage).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    await act(async () => finish(structuredClone(acknowledged)));
    await waitFor(() => expect(wikiApi.getPage).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(body()).toHaveValue("Acknowledged body");
    expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
    change(body(), "Next body");
    expect(screen.getByRole("button", { name: "Save version" })).toBeEnabled();
    page = { ...acknowledged, content: "Next body", currentVersionNumber: 4 };
    vi.mocked(wikiApi.saveVersion).mockResolvedValueOnce(structuredClone(page));
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(2));
    expect(wikiApi.saveVersion).toHaveBeenLastCalledWith("h", "p", {
      title: "Server title", content: "Next body", editSummary: undefined,
    });
    await act(async () => finishRead(structuredClone(page)));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["text", "older version", 2, "2026-10-17T00:00:01Z"],
    ["text", "older timestamp at the same version", 3, "2026-10-17T00:00:01Z"],
    ["metadata", "older version despite a later timestamp", 2, "2026-10-17T00:00:03Z"],
    ["metadata", "older version", 2, "2026-10-17T00:00:01Z"],
    ["metadata", "older timestamp at the same version", 3, "2026-10-17T00:00:01Z"],
  ] as const)("keeps acknowledged %s when the pending observation has an %s", async (group, _ordering, version, updatedAt) => {
    let finish!: (value: Page) => void;
    let finishRead!: (value: Page) => void;
    if (group === "text") vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    else vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    if (group === "text") change(body(), "Acknowledged body");
    else {
      change(screen.getByPlaceholderText("Add tag…"), "acknowledged");
      fireEvent.keyDown(screen.getByPlaceholderText("Add tag…"), { key: "Enter" });
    }
    const saveLabel = group === "text" ? "Save version" : "Save metadata";
    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    const mutation = group === "text" ? wikiApi.saveVersion : wikiApi.updatePageMetadata;
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
    const acknowledged = { ...page, currentVersionNumber: 3, updatedAt: "2026-10-17T00:00:02Z",
      ...(group === "text" ? { content: "Acknowledged body" } : { tags: ["acknowledged"] }) };
    page = { ...page, currentVersionNumber: version, updatedAt,
      ...(group === "text" ? { content: "Intermediate body", status: "published" as const } : { tags: ["intermediate"], content: "Observed body" }) };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    if (group === "text") await waitFor(() => expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published"));
    else await screen.findByDisplayValue("Observed body");
    expect(client.getQueryData(queryKeys.wiki.page("h", "p"))).toEqual(page);
    vi.mocked(wikiApi.getPage).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    await act(async () => finish(structuredClone(acknowledged)));
    await waitFor(() => expect(wikiApi.getPage).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    if (group === "text") {
      expect(body()).toHaveValue("Acknowledged body");
      expect(screen.getByRole("button", { name: saveLabel })).toBeDisabled();
      change(body(), "Next body");
      page = { ...acknowledged, content: "Next body", currentVersionNumber: 4 };
      vi.mocked(wikiApi.saveVersion).mockResolvedValueOnce(structuredClone(page));
    } else {
      expect(screen.getByText("#acknowledged")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: saveLabel })).not.toBeInTheDocument();
      change(screen.getByPlaceholderText("Add tag…"), "next");
      fireEvent.keyDown(screen.getByPlaceholderText("Add tag…"), { key: "Enter" });
      page = { ...acknowledged, tags: ["acknowledged", "next"], updatedAt: "2026-10-17T00:00:04Z" };
      vi.mocked(wikiApi.updatePageMetadata).mockResolvedValueOnce(structuredClone(page));
    }
    expect(screen.getByRole("button", { name: saveLabel })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(2));
    await act(async () => finishRead(structuredClone(page)));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["text", "metadata"] as const)("reconciles a higher-version %s observation despite an older timestamp", async (group) => {
    let finish!: (value: Page) => void;
    if (group === "text") vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    else vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    if (group === "text") change(body(), "Acknowledged body");
    else {
      change(screen.getByPlaceholderText("Add tag…"), "acknowledged");
      fireEvent.keyDown(screen.getByPlaceholderText("Add tag…"), { key: "Enter" });
    }
    fireEvent.click(screen.getByRole("button", { name: group === "text" ? "Save version" : "Save metadata" }));
    await waitFor(() => expect(group === "text" ? wikiApi.saveVersion : wikiApi.updatePageMetadata).toHaveBeenCalledTimes(1));
    const acknowledged = { ...page, currentVersionNumber: 2, updatedAt: "2026-10-17T00:00:02Z",
      ...(group === "text" ? { content: "Acknowledged body" } : { tags: ["acknowledged"] }) };
    // A later version restores the original value while the server clock moves back.
    page = { ...page, currentVersionNumber: 3, updatedAt: "2026-10-17T00:00:01Z",
      ...(group === "text" ? { status: "published" as const } : { content: "Observed body" }) };
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    if (group === "text") await waitFor(() => expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published"));
    else await screen.findByDisplayValue("Observed body");
    await act(async () => finish(structuredClone(acknowledged)));
    await screen.findByText(group === "text" ? "Content changed on the server." : "Tags changed on the server.");
    expect(screen.getByRole("button", { name: group === "text" ? "Save version" : "Save metadata" })).toBeDisabled();
    if (group === "text") expect(body()).toHaveValue("Acknowledged body");
    else expect(screen.getByText("#acknowledged")).toBeInTheDocument();
  });

  it.each(["text", "metadata"] as const)("reconciles an observably newer %s write that restores the pre-write value", async (group) => {
    let finish!: (value: Page) => void;
    if (group === "text") vi.mocked(wikiApi.saveVersion).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    else vi.mocked(wikiApi.updatePageMetadata).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(editor());
    await screen.findByDisplayValue("Server body");
    let acknowledged: Page;
    if (group === "text") {
      change(body(), "Submitted body");
      fireEvent.click(screen.getByRole("button", { name: "Save version" }));
      await waitFor(() => expect(wikiApi.saveVersion).toHaveBeenCalledTimes(1));
      acknowledged = { ...page, content: "Submitted body", currentVersionNumber: 2, updatedAt: "2026-10-17T00:00:01Z" };
      page = { ...page, currentVersionNumber: 3, updatedAt: "2026-10-17T00:00:02Z", status: "published" };
    } else {
      change(screen.getByRole("combobox", { name: "Status" }), "published");
      fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
      await waitFor(() => expect(wikiApi.updatePageMetadata).toHaveBeenCalledTimes(1));
      acknowledged = { ...page, status: "published", updatedAt: "2026-10-17T00:00:01Z" };
      page = { ...page, updatedAt: "2026-10-17T00:00:02Z", content: "Observed remote body" };
    }
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.wiki.page("h", "p"), exact: true }); });
    if (group === "text") await waitFor(() => expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published"));
    else await screen.findByDisplayValue("Observed remote body");
    await act(async () => finish(structuredClone(acknowledged)));
    await screen.findByText(group === "text" ? "Content changed on the server." : "Status changed on the server.");
    if (group === "text") expect(body()).toHaveValue("Submitted body");
    else expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("published");
  });

  it.each([false, true])("handles a create rejection during layout work with a retired editor: %s", async (retired) => {
    let reject!: (reason: Error) => void;
    let beginCommit!: () => void;
    let committed!: () => void;
    const replacementCommitted = new Promise<void>((resolve) => { committed = resolve; });
    const onDone = vi.fn();
    const errorNotification = vi.spyOn(toast, "error"); // Call through the real notify wrapper to Sonner.
    vi.mocked(wikiApi.createPage).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    function CommitProbe({ committing }: { committing: boolean }) {
      useLayoutEffect(() => {
        if (!committing) return;
        reject(new Error("Create rejected during layout"));
        const end = performance.now() + 20;
        while (performance.now() < end) { /* same real layout window as the success regression */ }
        committed();
      }, [committing]);
      return null;
    }
    function Host() {
      const [committing, setCommitting] = useState(false);
      beginCommit = () => startTransition(() => setCommitting(true));
      const editing = retired && committing;
      return <QueryClientProvider client={client}>
        <WikiEditor habitatId="h" mode={editing ? "edit" : "create"} pageId={editing ? "p" : undefined}
          onDone={onDone} onCancel={() => {}} />
        <CommitProbe committing={committing} />
      </QueryClientProvider>;
    }
    const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const environment = globals.IS_REACT_ACT_ENVIRONMENT;
    try {
      render(<Host />);
      change(title(), "New page");
      change(body(), "New body");
      fireEvent.click(screen.getByRole("button", { name: "Create page" }));
      await waitFor(() => expect(wikiApi.createPage).toHaveBeenCalledTimes(1));
      // act would flush passive cleanup and hide the actual identity-commit window.
      globals.IS_REACT_ACT_ENVIRONMENT = false;
      beginCommit();
      await replacementCommitted;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onDone).not.toHaveBeenCalled();
      if (retired) expect(errorNotification).not.toHaveBeenCalled();
      else {
        expect(errorNotification).toHaveBeenCalledTimes(1);
        expect(errorNotification).toHaveBeenCalledWith("Create rejected during layout", { duration: 10000 });
      }
    } finally {
      globals.IS_REACT_ACT_ENVIRONMENT = environment;
      errorNotification.mockRestore();
      toast.dismiss();
    }
  });

  it("retires the old editor during an identity commit before a pending create completes", async () => {
    let finish!: (value: Page) => void;
    let switchIdentity!: () => void;
    let committed!: () => void;
    const replacementCommitted = new Promise<void>((resolve) => { committed = resolve; });
    const onDone = vi.fn();
    vi.mocked(wikiApi.createPage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    function CommitProbe({ editing }: { editing: boolean }) {
      useLayoutEffect(() => {
        if (!editing) return;
        finish({ ...page, id: "created" });
        // A real replacement commit can consume a scheduler slice before passive cleanup.
        // Resolve the HTTP boundary in that window without invoking private editor callbacks.
        const end = performance.now() + 20;
        while (performance.now() < end) { /* simulate other layout work in the same commit */ }
        committed();
      }, [editing]);
      return null;
    }
    function Host() {
      const [editing, setEditing] = useState(false);
      switchIdentity = () => startTransition(() => setEditing(true));
      return <QueryClientProvider client={client}>
        <WikiEditor habitatId="h" mode={editing ? "edit" : "create"} pageId={editing ? "p" : undefined}
          onDone={onDone} onCancel={() => {}} />
        <CommitProbe editing={editing} />
      </QueryClientProvider>;
    }
    render(<Host />);
    change(title(), "New page");
    change(body(), "New body");
    fireEvent.click(screen.getByRole("button", { name: "Create page" }));
    await waitFor(() => expect(wikiApi.createPage).toHaveBeenCalledTimes(1));
    // act intentionally flushes passive effects and would hide the browser commit window.
    const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const environment = globals.IS_REACT_ACT_ENVIRONMENT;
    try {
      globals.IS_REACT_ACT_ENVIRONMENT = false;
      switchIdentity();
      await replacementCommitted;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      globals.IS_REACT_ACT_ENVIRONMENT = environment;
    }
  });

});
