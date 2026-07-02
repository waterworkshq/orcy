import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TriageSettingsTab, type TriageSettingsTabHandle } from "./TriageSettingsTab.js";
import type { TriageSettings } from "../../../types/index.js";
import { useRef, createRef } from "react";

const mockUpdate = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock("../../../api/index.js", () => ({
  api: {
    habitats: {
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock("../../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock("../../ui/NumberField.js", () => ({
  NumberField: ({ label, value, onChange, id }: any) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        data-testid={`field-${id}`}
        id={id}
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
      />
    </div>
  ),
}));

const defaultSettings: TriageSettings = {
  minClusterSize: 3,
  clusterWindowDays: 7,
  agentQualityThreshold: 40,
  agentQualityMinSample: 5,
};

describe("TriageSettingsTab", () => {
  const mockOnUpdate = vi.fn();
  const mockOnSavingChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("renders with defaults when boardTriageSettings is null", () => {
    const ref = createRef<TriageSettingsTabHandle>();
    render(
      <TriageSettingsTab
        ref={ref}
        habitatId="hab-1"
        boardTriageSettings={null}
        onUpdate={mockOnUpdate}
        onSavingChange={mockOnSavingChange}
      />,
    );
    expect((screen.getByTestId("field-triage-min-cluster") as HTMLInputElement).value).toBe("3");
    expect((screen.getByTestId("field-triage-window") as HTMLInputElement).value).toBe("7");
  });

  it("renders with saved values when boardTriageSettings is provided", () => {
    const ref = createRef<TriageSettingsTabHandle>();
    render(
      <TriageSettingsTab
        ref={ref}
        habitatId="hab-1"
        boardTriageSettings={{
          minClusterSize: 5,
          clusterWindowDays: 14,
          agentQualityThreshold: 30,
          agentQualityMinSample: 10,
        }}
        onUpdate={mockOnUpdate}
        onSavingChange={mockOnSavingChange}
      />,
    );
    expect((screen.getByTestId("field-triage-min-cluster") as HTMLInputElement).value).toBe("5");
    expect((screen.getByTestId("field-triage-window") as HTMLInputElement).value).toBe("14");
  });

  it("resyncs form values when boardTriageSettings prop changes", () => {
    const ref = createRef<TriageSettingsTabHandle>();
    const { rerender } = render(
      <TriageSettingsTab
        ref={ref}
        habitatId="hab-1"
        boardTriageSettings={defaultSettings}
        onUpdate={mockOnUpdate}
        onSavingChange={mockOnSavingChange}
      />,
    );

    // Change to a different habitat with different settings
    rerender(
      <TriageSettingsTab
        ref={ref}
        habitatId="hab-2"
        boardTriageSettings={{
          minClusterSize: 8,
          clusterWindowDays: 30,
          agentQualityThreshold: 50,
          agentQualityMinSample: 3,
        }}
        onUpdate={mockOnUpdate}
        onSavingChange={mockOnSavingChange}
      />,
    );

    expect((screen.getByTestId("field-triage-min-cluster") as HTMLInputElement).value).toBe("8");
    expect((screen.getByTestId("field-triage-window") as HTMLInputElement).value).toBe("30");
    expect((screen.getByTestId("field-triage-quality-threshold") as HTMLInputElement).value).toBe(
      "50",
    );
  });

  it("saves settings via imperative handle", async () => {
    mockUpdate.mockResolvedValue({ board: { id: "hab-1", triageSettings: defaultSettings } });

    const ref = createRef<TriageSettingsTabHandle>();
    render(
      <TriageSettingsTab
        ref={ref}
        habitatId="hab-1"
        boardTriageSettings={defaultSettings}
        onUpdate={mockOnUpdate}
        onSavingChange={mockOnSavingChange}
      />,
    );

    await ref.current!.save();

    expect(mockUpdate).toHaveBeenCalledWith(
      "hab-1",
      expect.objectContaining({
        triageSettings: expect.objectContaining({
          minClusterSize: 3,
          clusterWindowDays: 7,
        }),
      }),
    );
    expect(mockNotifySuccess).toHaveBeenCalled();
  });

  it("surfaces error on save failure", async () => {
    mockUpdate.mockRejectedValue(new Error("Network error"));

    const ref = createRef<TriageSettingsTabHandle>();
    render(
      <TriageSettingsTab
        ref={ref}
        habitatId="hab-1"
        boardTriageSettings={defaultSettings}
        onUpdate={mockOnUpdate}
        onSavingChange={mockOnSavingChange}
      />,
    );

    await ref.current!.save();

    expect(mockNotifyError).toHaveBeenCalledWith("Network error");
  });
});
