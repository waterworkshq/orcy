import { describe, expect, it } from "vitest";
import { buildMissionPulseListParams } from "./useMissionPulseFeed.js";

describe("buildMissionPulseListParams", () => {
  it("hides query-param construction for paging, auto, and experience", () => {
    const params = buildMissionPulseListParams({
      pageParam: 1,
      activeTypes: [],
      hideAuto: true,
      showExperience: false,
    });
    expect(params.limit).toBe(20);
    expect(params.offset).toBe(20);
    expect(params.isAuto).toBe("false");
    expect(String(params.signalTypes)).not.toContain("experience");
  });

  it("joins selected types and omits isAuto when autos are shown", () => {
    expect(
      buildMissionPulseListParams({
        pageParam: 0,
        activeTypes: ["finding", "experience"],
        hideAuto: false,
        showExperience: true,
      }),
    ).toEqual({
      limit: 20,
      offset: 0,
      signalTypes: "finding,experience",
    });
  });
});
