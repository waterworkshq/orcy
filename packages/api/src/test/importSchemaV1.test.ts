import { describe, it, expect } from "vitest";
import { importHabitatSchema } from "../models/schemas.js";

// The re-review found that importHabitatSchema (a strict z.object) stripped
// unknown `features`/`board` keys before the service ran, so a direct v1 HTTP
// import lost the mission collection. These tests prove the schema-level
// preprocess now normalizes legacy v1 shapes at the HTTP validation boundary.

const baseV1Habitat = {
  name: "Imported Habitat",
  columns: [{ name: "Todo", order: 0 }],
};

const v1Mission = {
  title: "Alpha",
  columnName: "Todo",
  priority: "high",
};

function validEnvelope(habitat: Record<string, unknown>) {
  return {
    version: 1,
    exportedAt: "2024-01-01T00:00:00.000Z",
    habitat,
  };
}

describe("importHabitatSchema — v1 legacy normalization at the HTTP boundary", () => {
  it("maps habitat.features -> habitat.missions when missions is absent", () => {
    const parsed = importHabitatSchema.parse(
      validEnvelope({ ...baseV1Habitat, features: [v1Mission, { ...v1Mission, title: "Beta" }] }),
    );
    expect(parsed.habitat.missions).toHaveLength(2);
    expect(parsed.habitat.missions[0].title).toBe("Alpha");
  });

  it("maps top-level board -> habitat for board-root v1 payloads", () => {
    const parsed = importHabitatSchema.parse({
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      board: { ...baseV1Habitat, features: [v1Mission] },
    });
    expect(parsed.habitat.name).toBe("Imported Habitat");
    expect(parsed.habitat.missions).toHaveLength(1);
  });

  it("canonical v2 (habitat.missions) still parses unchanged", () => {
    const parsed = importHabitatSchema.parse(
      validEnvelope({ ...baseV1Habitat, missions: [v1Mission] }),
    );
    expect(parsed.habitat.missions).toHaveLength(1);
    expect(parsed.habitat.missions[0].title).toBe("Alpha");
  });

  it("missions takes precedence when both missions and features are present", () => {
    const parsed = importHabitatSchema.parse(
      validEnvelope({
        ...baseV1Habitat,
        missions: [{ ...v1Mission, title: "Canonical" }],
        features: [{ ...v1Mission, title: "Legacy" }],
      }),
    );
    expect(parsed.habitat.missions).toHaveLength(1);
    expect(parsed.habitat.missions[0].title).toBe("Canonical");
  });

  it("default to empty missions when neither missions nor features is present", () => {
    const parsed = importHabitatSchema.parse(validEnvelope({ ...baseV1Habitat }));
    expect(parsed.habitat.missions).toEqual([]);
  });
});
