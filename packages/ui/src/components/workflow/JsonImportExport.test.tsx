import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { JsonImportExport } from "./JsonImportExport.js";
import type { WorkflowTemplateDefinition } from "../../types/index.js";

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    promise: vi.fn(),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

const sampleValue: WorkflowTemplateDefinition = {
  gates: [],
  joinSpecs: {},
  variables: [],
};

/** Render the component with a fresh `onImport` spy for each test. */
function renderWithSpy() {
  const onImport = vi.fn();
  const utils = render(<JsonImportExport value={sampleValue} onImport={onImport} />);
  return { onImport, ...utils };
}

/** Replace the textarea contents with the given JSON string. */
function setTextarea(text: string) {
  const textarea = screen.getByTestId("json-textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
}

/** Click the Import (JSON → Form) button. */
function clickImport() {
  fireEvent.click(screen.getByTestId("json-import"));
}

describe("JsonImportExport — handleImport validation guard", () => {
  it("valid JSON with gates array → onImport called with parsed object + success toast", async () => {
    const { notify } = await import("../../lib/toast.js");
    const { onImport } = renderWithSpy();

    const parsed: WorkflowTemplateDefinition = {
      gates: [
        { upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" },
      ],
      joinSpecs: {},
      variables: [],
    };
    setTextarea(JSON.stringify(parsed));
    clickImport();

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledWith(parsed);
    expect(notify.success).toHaveBeenCalledWith("Workflow imported from JSON");
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("malformed JSON → error toast, onImport NOT called", async () => {
    const { notify } = await import("../../lib/toast.js");
    const { onImport } = renderWithSpy();

    setTextarea("{broken");
    clickImport();

    expect(onImport).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledTimes(1);
    // The wrapped error message starts with "Import failed:" — JSON.parse's message
    // changes across runtimes, so we just assert the prefix + non-empty body.
    const call = vi.mocked(notify.error).mock.calls[0][0];
    expect(call.startsWith("Import failed:")).toBe(true);
    expect(call.length).toBeGreaterThan("Import failed:".length);
  });

  it("valid JSON but gates is not an array (string) → error toast, onImport NOT called", async () => {
    const { notify } = await import("../../lib/toast.js");
    const { onImport } = renderWithSpy();

    setTextarea('{"gates": "string"}');
    clickImport();

    expect(onImport).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error).toHaveBeenCalledWith(
      'Import failed: Invalid workflow: "gates" must be an array',
    );
  });

  it("valid JSON but gates is missing entirely → error toast, onImport NOT called", async () => {
    const { notify } = await import("../../lib/toast.js");
    const { onImport } = renderWithSpy();

    setTextarea('{"joinSpecs": {}, "variables": []}');
    clickImport();

    expect(onImport).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledWith(
      'Import failed: Invalid workflow: "gates" must be an array',
    );
  });

  it("valid JSON with gates as object (also non-array) → error toast, onImport NOT called", async () => {
    const { notify } = await import("../../lib/toast.js");
    const { onImport } = renderWithSpy();

    setTextarea('{"gates": {"foo": "bar"}}');
    clickImport();

    expect(onImport).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).toHaveBeenCalledWith(
      'Import failed: Invalid workflow: "gates" must be an array',
    );
  });

  it("empty gates array is valid (no entries, but is an array) → onImport called", async () => {
    const { notify } = await import("../../lib/toast.js");
    const { onImport } = renderWithSpy();

    const empty: WorkflowTemplateDefinition = { gates: [] };
    setTextarea(JSON.stringify(empty));
    clickImport();

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledWith(empty);
    expect(notify.success).toHaveBeenCalledWith("Workflow imported from JSON");
    expect(notify.error).not.toHaveBeenCalled();
  });
});