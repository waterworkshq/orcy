import { vi } from "vitest";

vi.mock("./src/lib/useHabitatData.js", async (importOriginal: any) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useBoard: () => ({
      data: {
        board: { id: "board-1", name: "Test Board", description: "" },
        columns: [],
        features: [],
      },
      isLoading: false,
      isError: false,
    }),
  };
});
