import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useHabitatSettingsSaver } from "./useHabitatSettingsSaver.js";

const mockUpdate = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock("../api/index.js", () => ({
  api: {
    habitats: {
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock("../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

describe("useHabitatSettingsSaver", () => {
  const mockOnUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockResolvedValue({ habitat: { id: "b1", name: "Test" } });
  });

  it("starts with saving=false", () => {
    const { result } = renderHook(() =>
      useHabitatSettingsSaver({
        habitatId: "b1",
        onUpdate: mockOnUpdate,
      }),
    );
    expect(result.current.saving).toBe(false);
  });

  it("calls API and manages saving state", async () => {
    const { result } = renderHook(() =>
      useHabitatSettingsSaver({
        habitatId: "b1",
        onUpdate: mockOnUpdate,
      }),
    );

    let saved = false;
    await act(async () => {
      saved = await result.current.saveSettings({ name: "New Name" }, "Saved!");
    });

    expect(saved).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mockUpdate).toHaveBeenCalledWith("b1", { name: "New Name" });
    expect(mockOnUpdate).toHaveBeenCalledWith({ id: "b1", name: "Test" });
    expect(mockNotifySuccess).toHaveBeenCalledWith("Saved!");
    expect(result.current.saving).toBe(false);
  });

  it("shows error notification on failure and clears error on successful retry", async () => {
    mockUpdate.mockRejectedValueOnce(new Error("API error"));

    const { result } = renderHook(() =>
      useHabitatSettingsSaver({
        habitatId: "b1",
        onUpdate: mockOnUpdate,
      }),
    );

    let firstSaved = true;
    await act(async () => {
      firstSaved = await result.current.saveSettings({ name: "Fail" }, "Should not show");
    });

    expect(firstSaved).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBe("API error");
    expect(mockOnUpdate).not.toHaveBeenCalled();
    expect(mockNotifyError).toHaveBeenCalledWith("API error");
    expect(mockNotifySuccess).not.toHaveBeenCalled();

    let retrySaved = false;
    await act(async () => {
      retrySaved = await result.current.saveSettings({ name: "Retry" }, "Saved!");
    });

    expect(retrySaved).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mockOnUpdate).toHaveBeenCalledWith({ id: "b1", name: "Test" });
    expect(mockNotifySuccess).toHaveBeenCalledWith("Saved!");
  });
});
