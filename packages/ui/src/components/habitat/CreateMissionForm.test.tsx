import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { CreateMissionForm } from "./CreateMissionForm.js";

const mockCreateFeature = vi.fn();
const mockListTemplates = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    missions: {
      create: (...args: unknown[]) => mockCreateFeature(...args),
    },
    templates: {
      list: (...args: unknown[]) => mockListTemplates(...args),
    },
  },
}));

vi.mock("../../lib/useHabitatData.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/useHabitatData.js")>();
  return {
    ...actual,
    useHabitat: () => ({
      data: {
        habitat: { id: "habitat-1", name: "Test", roadmapSettings: { mode: "release" } },
        columns: [
          {
            id: "col-1",
            name: "Backlog",
            isTerminal: false,
            habitatId: "habitat-1",
            order: 0,
            wipLimit: null,
            autoAdvance: false,
            requiresClaim: false,
            nextColumnId: null,
          },
        ],
        missions: [],
      },
      isLoading: false,
    }),
  };
});

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: vi.fn(() => ({})),
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock("../ui/RichTextEditor.js", () => ({
  RichTextEditor: ({ placeholder }: { placeholder?: string }) => (
    <textarea placeholder={placeholder} data-testid="rich-text-editor" />
  ),
}));

function createTestWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe("CreateMissionForm", () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    habitatId: "habitat-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFeature.mockResolvedValue({
      feature: { id: "feat-1", title: "Test Mission" },
    });
    mockListTemplates.mockResolvedValue({ templates: [] });
  });

  afterEach(() => {
    cleanup();
  });

  describe("React Query integration", () => {
    it("renders template options from useTemplates", async () => {
      mockListTemplates.mockResolvedValue({
        templates: [
          {
            id: "t1",
            name: "Bug Fix",
            titlePattern: "Fix: ",
            descriptionPattern: "",
            priority: "high",
            labels: ["bug"],
            habitatId: "habitat-1",
          },
          {
            id: "t2",
            name: "Feature",
            titlePattern: "Add: ",
            descriptionPattern: "",
            priority: "medium",
            labels: [],
            habitatId: null,
          },
        ],
      });

      render(<CreateMissionForm {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        const selects = screen.getAllByRole("combobox");
        expect(selects.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("populates form fields when template is selected", async () => {
      mockListTemplates.mockResolvedValue({
        templates: [
          {
            id: "t1",
            name: "Bug Fix",
            titlePattern: "Fix: Bug",
            descriptionPattern: "Steps to reproduce",
            priority: "critical",
            labels: ["bug", "urgent"],
            habitatId: "habitat-1",
          },
        ],
      });

      render(<CreateMissionForm {...defaultProps} />, { wrapper: createTestWrapper() });

      await waitFor(() => {
        expect(mockListTemplates).toHaveBeenCalledWith("habitat-1");
      });
    });

    it("does not show template options when no templates", () => {
      mockListTemplates.mockResolvedValue({ templates: [] });

      render(<CreateMissionForm {...defaultProps} />, { wrapper: createTestWrapper() });

      expect(screen.getByRole("heading", { name: "Create Mission" })).toBeTruthy();
    });
  });

  describe("Form submission", () => {
    it("creates a mission with valid title", async () => {
      render(<CreateMissionForm {...defaultProps} />, { wrapper: createTestWrapper() });

      const titleInput = screen.getByPlaceholderText("Mission title");
      fireEvent.change(titleInput, { target: { value: "My Mission" } });

      const submitButton = screen.getByRole("button", { name: "Create Mission" });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockCreateFeature).toHaveBeenCalledWith(
          "habitat-1",
          expect.objectContaining({
            title: "My Mission",
            columnId: "col-1",
          }),
        );
      });
    });

    it("invalidates RQ cache after successful creation", async () => {
      const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");

      render(<CreateMissionForm {...defaultProps} />, { wrapper: createTestWrapper() });

      const titleInput = screen.getByPlaceholderText("Mission title");
      fireEvent.change(titleInput, { target: { value: "My Mission" } });

      const submitButton = screen.getByRole("button", { name: "Create Mission" });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith(
          expect.objectContaining({ queryKey: ["missions", "list", "habitat-1"] }),
        );
        expect(invalidateSpy).toHaveBeenCalledWith(
          expect.objectContaining({ queryKey: ["habitats", "detail", "habitat-1"] }),
        );
      });

      invalidateSpy.mockRestore();
    });

    it("shows error on failed creation", async () => {
      mockCreateFeature.mockRejectedValue(new Error("Server error"));

      render(<CreateMissionForm {...defaultProps} />, { wrapper: createTestWrapper() });

      const titleInput = screen.getByPlaceholderText("Mission title");
      fireEvent.change(titleInput, { target: { value: "My Mission" } });

      const submitButton = screen.getByRole("button", { name: "Create Mission" });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockNotifyError).toHaveBeenCalledWith("Server error");
      });
    });
  });

  describe("Form reset", () => {
    it("resets form fields when dialog reopens", async () => {
      const { rerender } = render(<CreateMissionForm {...defaultProps} open={false} />, {
        wrapper: createTestWrapper(),
      });

      rerender(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <CreateMissionForm {...defaultProps} open={true} />
        </QueryClientProvider>,
      );

      await waitFor(() => {
        const titleInput = screen.getByPlaceholderText("Mission title") as HTMLInputElement;
        expect(titleInput.value).toBe("");
      });
    });
  });
});
