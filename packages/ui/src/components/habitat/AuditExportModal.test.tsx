import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuditExportModal } from "./AuditExportModal.js";

const notifications = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("../../lib/toast.js", () => ({ notify: notifications }));
vi.mock("../../lib/sessionState.js", () => ({ useSessionLiveness: () => () => true }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("AuditExportModal download", () => {
  it.each([
    ["csv", "text/csv; charset=utf-8", "id,action\n1,updated\n2,created\n", "id,action\n"],
    ["json", "application/json; charset=utf-8", '[{"id":"1"},{"id":"2"}]', "[]"],
    ["jsonl", "application/x-ndjson; charset=utf-8", '{"id":"1"}\n{"id":"2"}\n', ""],
  ])("downloads %s bytes, type and filename for populated and empty results", async (format, mime, populated, empty) => {
    for (const [body, truncated] of [[populated, "true"], [empty, "false"]]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "Content-Type": mime, "X-Audit-Result-Truncated": truncated, "X-Audit-Result-Partial": "false" } }));
      vi.stubGlobal("fetch", fetchMock);
      const createUrl = vi.fn().mockReturnValue("blob:test");
      vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
      let filename = "";
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
      const close = vi.fn();
      const view = render(<AuditExportModal habitatId="habitat-123" open onClose={close} />);
      fireEvent.change(screen.getByDisplayValue("CSV (spreadsheets)"), { target: { value: format } });
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/api/habitats/habitat-123/audit/export?format=${format}`), expect.anything());
      const blob = createUrl.mock.calls[0][0] as Blob;
      expect(await blob.text()).toBe(body);
      expect(blob.type).toBe(mime.replace("; ", ";"));
      expect(filename).toMatch(new RegExp(`^audit-habitat--\\d{4}-\\d{2}-\\d{2}\\.${format}$`));
      expect(click).toHaveBeenCalledOnce();
      if (truncated === "true") {
        expect(notifications.warning).toHaveBeenCalledWith(expect.stringContaining("incomplete"));
        expect(notifications.success).not.toHaveBeenCalled();
      } else {
        expect(notifications.success).toHaveBeenCalledWith("Audit log exported");
        expect(notifications.warning).not.toHaveBeenCalled();
      }
      view.unmount();
      click.mockRestore();
      vi.clearAllMocks();
    }
  });

  it("warns when a source is unavailable even without truncation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { headers: { "X-Audit-Result-Truncated": "false", "X-Audit-Result-Partial": "true" } })));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn().mockReturnValue("blob:test"), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AuditExportModal habitatId="habitat-123" open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(notifications.warning).toHaveBeenCalledWith(expect.stringContaining("incomplete")));
    expect(notifications.success).not.toHaveBeenCalled();
  });

  it("does not claim completeness when an older server omits the partial header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { headers: { "X-Audit-Result-Truncated": "false" } })));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn().mockReturnValue("blob:test"), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AuditExportModal habitatId="habitat-123" open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(notifications.warning).toHaveBeenCalledWith(expect.stringContaining("could not be determined")));
    expect(notifications.success).not.toHaveBeenCalled();
  });

  it.each(["csv", "json", "jsonl"])("reports an HTTP error without downloading %s", async (format) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Access denied" }), { status: 403, headers: { "Content-Type": "application/json" } })));
    const createUrl = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
    const close = vi.fn();
    render(<AuditExportModal habitatId="habitat-123" open onClose={close} />);
    fireEvent.change(screen.getByDisplayValue("CSV (spreadsheets)"), { target: { value: format } });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(notifications.error).toHaveBeenCalledWith("Access denied"));
    expect(createUrl).not.toHaveBeenCalled();
    expect(notifications.success).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
