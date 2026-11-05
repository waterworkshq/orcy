import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MissionWithProgress } from "../types/index.js";
import { emptyMissionDraft, missionToDraft, createMissionInputFromDraft, updateMissionInputFromDraft, titleReady, useMissionAuthoring } from "./missionAuthoring.js";

const mission = {
  id: "m1", version: 3, title: "Original", description: "desc", priority: "high", labels: ["one"],
  dueAt: null, slaMinutes: null, releaseGateType: "minor", releaseGateVersion: "v1.0",
  releaseDeadlineType: null, releaseDeadlineVersion: null,
} as MissionWithProgress;

describe("Mission-specific authoring rules", () => {
  // GROUND: T2 ticket Step 1 test 1; DESIGN §2 title row (trim, nonempty gate shared by both journeys); PRD M1/M3.
  it("uses one title readiness rule for empty, whitespace and nonempty drafts", () => {
    expect(titleReady(emptyMissionDraft())).toBe(false);
    expect(titleReady({ ...emptyMissionDraft(), title: "   " })).toBe(false);
    expect(titleReady({ ...emptyMissionDraft(), title: " Title " })).toBe(true);
  });
  // GROUND: T2 ticket Step 1 test 2; DESIGN §2 description/labels/slaMinutes rows (Create omits empties, Edit clears with ""/[]/null); PRD M2.
  it("preserves create omission versus edit clearing and trims/filter labels", () => {
    const draft = { ...emptyMissionDraft(), title: "  Title  ", labels: " a, , b ,, " };
    const create = createMissionInputFromDraft(draft, "column", "  criteria  ");
    expect(create).toMatchObject({ columnId: "column", title: "Title", acceptanceCriteria: "criteria", labels: ["a", "b"] });
    expect(create.description).toBeUndefined();
    expect(create.dueAt).toBeUndefined();
    expect(create.slaMinutes).toBeUndefined();
    expect("version" in create).toBe(false);
    const edit = updateMissionInputFromDraft(draft, 3, true);
    expect(edit).toMatchObject({ title: "Title", description: "", dueAt: null, slaMinutes: null, labels: ["a", "b"], version: 3 });
    expect(updateMissionInputFromDraft({ ...draft, labels: " ,  , " }, 3, true).labels).toEqual([]);
  });
  // GROUND: T2 ticket Step 1 test 3; DESIGN §2 gate/deadline rows + feature-mode paragraph (Edit omits release keys when hidden; Create never submits inapplicable version); PRD M4.
  it("drops inapplicable release versions and preserves hidden feature-mode fields by omission", () => {
    const draft = { ...emptyMissionDraft(), title: "Title", releaseGateVersion: "v2", releaseDeadlineVersion: "v3" };
    expect(createMissionInputFromDraft(draft, "column", "").releaseGateVersion).toBeUndefined();
    expect(createMissionInputFromDraft(draft, "column", "").releaseDeadlineVersion).toBeUndefined();
    expect(updateMissionInputFromDraft(draft, 3, true)).toMatchObject({ releaseGateType: null, releaseGateVersion: null, releaseDeadlineType: null, releaseDeadlineVersion: null });
    const hidden = updateMissionInputFromDraft(missionToDraft(mission), 3, false);
    expect("releaseGateType" in hidden).toBe(false);
    expect("releaseGateVersion" in hidden).toBe(false);
    expect("releaseDeadlineType" in hidden).toBe(false);
    expect("releaseDeadlineVersion" in hidden).toBe(false);
  });
  // GROUND: T2 ticket Step 1 test 4; DESIGN §2 dueAt/slaMinutes rows (existing datetime-local → ISO and parseInt conversion unchanged); PRD M8.
  it("keeps existing date and SLA conversion", () => {
    const draft = { ...emptyMissionDraft(), title: "T", dueAt: "2026-01-02T03:04", slaMinutes: "45" };
    expect(createMissionInputFromDraft(draft, "column", "")).toMatchObject({ dueAt: new Date(draft.dueAt).toISOString(), slaMinutes: 45 });
  });
  // GROUND: T2 ticket Step 1 test 5; DESIGN §3 session lifetime (same open id refetch never rebases; close/reopen or id switch resets); PRD M5.
  it("pins open draft and baseline across refetch; resets on close/reopen and selected id change", () => {
    const { result, rerender } = renderHook(({ open, value }) => useMissionAuthoring(open, value), {
      initialProps: { open: true, value: mission },
    });
    act(() => result.current.setTitle("Typed"));
    rerender({ open: true, value: { ...mission, title: "Server", version: 4 } });
    expect(result.current.title).toBe("Typed");
    expect(result.current.baselineVersion).toBe(3);
    rerender({ open: false, value: { ...mission, title: "Server", version: 4 } });
    rerender({ open: true, value: { ...mission, title: "Server", version: 4 } });
    expect(result.current.title).toBe("Server");
    expect(result.current.baselineVersion).toBe(4);
    rerender({ open: true, value: { ...mission, id: "m2", title: "Other", version: 8 } });
    expect(result.current.title).toBe("Other");
    expect(result.current.baselineMissionId).toBe("m2");
    expect(result.current.baselineVersion).toBe(8);
  });
});
