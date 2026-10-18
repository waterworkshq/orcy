import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

});
