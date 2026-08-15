import { describe, it, expect } from "vitest";
import { ApiError } from "../api/transport.js";
import { isVersionConflict } from "./habitatMutations.js";

/**
 * Regression matrix for the 409 classification fix: only genuine version
 * races (`VERSION_CONFLICT`, legacy generic `CONFLICT`) take the reconcile
 * flow. Mission lifecycle guards carry distinct codes and must NOT be
 * classified as races — their server message states the real remedy.
 */
describe("isVersionConflict — typed 409 classification", () => {
  const raceCodes = ["VERSION_CONFLICT", "CONFLICT"] as const;
  const guardCodes = [
    "MISSION_GATE_CLEAR_BLOCKED",
    "MISSION_GATE_CHANGE_BLOCKED",
    "MISSION_ARCHIVE_HAS_NON_TERMINAL_FINDINGS",
    "MISSION_HAS_FINDING_LINKS",
    "LIFECYCLE_BUSY",
  ] as const;

  it.each(raceCodes)("classifies 409 %s as a version race", (code) => {
    const err = new ApiError("Version conflict", 409, { error: "Version conflict", code });
    expect(isVersionConflict(err)).toBe(true);
  });

  it.each(guardCodes)("does NOT classify 409 %s as a version race", (code) => {
    const err = new ApiError("Guard blocked this mutation", 409, {
      error: "Guard blocked this mutation",
      code,
    });
    expect(isVersionConflict(err)).toBe(false);
  });

  it("rejects non-409 statuses and non-ApiError throwables", () => {
    expect(isVersionConflict(new ApiError("Not found", 404, { code: "VERSION_CONFLICT" }))).toBe(
      false,
    );
    expect(isVersionConflict(new Error("Version conflict"))).toBe(false);
    expect(isVersionConflict(null)).toBe(false);
  });

  it("treats a 409 without a recognized body code as a non-race", () => {
    // The error middleware always sends `code`; an unrecognized code means an
    // unknown guard — surface its message rather than the reconcile flow.
    expect(isVersionConflict(new ApiError("HTTP 409", 409))).toBe(false);
    expect(isVersionConflict(new ApiError("HTTP 409", 409, { error: "HTTP 409" }))).toBe(false);
    expect(
      isVersionConflict(new ApiError("HTTP 409", 409, { error: "HTTP 409", code: 409 })),
    ).toBe(false);
  });
});
