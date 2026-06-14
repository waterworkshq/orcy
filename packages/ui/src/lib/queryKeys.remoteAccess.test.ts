import { describe, it, expect } from "vitest";
import { queryKeys } from "../lib/queryKeys.js";

describe("queryKeys.remoteAccess", () => {
  it("has a management key scoped to habitatId", () => {
    const key = queryKeys.remoteAccess.management("habitat-1");
    expect(key).toEqual(["remoteAccess", "management", "habitat-1"]);
  });

  it("has a readiness key scoped to habitatId", () => {
    const key = queryKeys.remoteAccess.readiness("habitat-1");
    expect(key).toEqual(["remoteAccess", "readiness", "habitat-1"]);
  });

  it("has pods, grants, participants, webhookEndpoints keys", () => {
    expect(queryKeys.remoteAccess.pods("h1")).toEqual(["remoteAccess", "pods", "h1"]);
    expect(queryKeys.remoteAccess.grants("h1")).toEqual(["remoteAccess", "grants", "h1"]);
    expect(queryKeys.remoteAccess.participants("h1")).toEqual([
      "remoteAccess",
      "participants",
      "h1",
    ]);
    expect(queryKeys.remoteAccess.webhookEndpoints("h1")).toEqual([
      "remoteAccess",
      "webhookEndpoints",
      "h1",
    ]);
  });

  it("has an all key", () => {
    expect(queryKeys.remoteAccess.all).toEqual(["remoteAccess"]);
  });
});
