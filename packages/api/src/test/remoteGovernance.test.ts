import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import { getRemoteGovernanceSettings } from "../services/remoteGovernance.js";
import type { RemoteGovernanceSettings } from "@orcy/shared";

let habitatId: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Governance Habitat" });
  habitatId = habitat.id;

  savedEnv = process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT;
  else process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT = savedEnv;
  closeDb();
});

/** Update the habitat's `remoteGovernanceSettings` JSON column. */
function setRemoteGovernanceSettings(value: RemoteGovernanceSettings | null) {
  const db = getDb();
  db.update(habitats)
    .set({ remoteGovernanceSettings: value })
    .where(eq(habitats.id, habitatId))
    .run();
}

describe("remoteGovernanceSettings — round-trip (proves migration applied)", () => {
  it("persists and reads back via updateHabitat", () => {
    habitatRepo.updateHabitat(habitatId, {
      remoteGovernanceSettings: {
        applyInterceptorsToRemote: true,
        enforceHostApprovedCapability: false,
      },
    });

    const reloaded = habitatRepo.getHabitatById(habitatId);
    expect(reloaded?.remoteGovernanceSettings).toEqual({
      applyInterceptorsToRemote: true,
      enforceHostApprovedCapability: false,
    });
  });

  it("defaults to null on a freshly created habitat", () => {
    const fresh = habitatRepo.getHabitatById(habitatId);
    expect(fresh?.remoteGovernanceSettings).toBeNull();
  });

  it("can be cleared back to null after being set", () => {
    habitatRepo.updateHabitat(habitatId, {
      remoteGovernanceSettings: {
        applyInterceptorsToRemote: true,
        enforceHostApprovedCapability: true,
      },
    });
    habitatRepo.updateHabitat(habitatId, {
      remoteGovernanceSettings: null,
    });

    const reloaded = habitatRepo.getHabitatById(habitatId);
    expect(reloaded?.remoteGovernanceSettings).toBeNull();
  });
});

describe("getRemoteGovernanceSettings — effective-value resolution", () => {
  it("both flags default to true when env unset and habitat column is null", () => {
    delete process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT;
    setRemoteGovernanceSettings(null);

    const result = getRemoteGovernanceSettings(habitatId);
    expect(result).toEqual({
      applyInterceptorsToRemote: true,
      enforceHostApprovedCapability: true,
    });
  });

  it("habitat override wins over env default", () => {
    process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT = "true";
    setRemoteGovernanceSettings({
      applyInterceptorsToRemote: false,
      enforceHostApprovedCapability: true,
    });

    const result = getRemoteGovernanceSettings(habitatId);
    expect(result).toEqual({
      applyInterceptorsToRemote: false,
      enforceHostApprovedCapability: true,
    });
  });

  it("env=true applies when habitat field is unset (null)", () => {
    process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT = "true";
    setRemoteGovernanceSettings(null);

    const result = getRemoteGovernanceSettings(habitatId);
    expect(result).toEqual({
      applyInterceptorsToRemote: true,
      enforceHostApprovedCapability: true,
    });
  });

  it("env=false applies when habitat field is unset (null)", () => {
    process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT = "false";
    setRemoteGovernanceSettings(null);

    const result = getRemoteGovernanceSettings(habitatId);
    expect(result).toEqual({
      applyInterceptorsToRemote: false,
      enforceHostApprovedCapability: false,
    });
  });

  it("truthy env variants (1, yes, on) all resolve to true", () => {
    setRemoteGovernanceSettings(null);

    for (const variant of ["1", "yes", "on", "TRUE", "Yes", "ON"]) {
      process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT = variant;
      const result = getRemoteGovernanceSettings(habitatId);
      expect(result).toEqual({
        applyInterceptorsToRemote: true,
        enforceHostApprovedCapability: true,
      });
    }
  });

  it("non-truthy env variants resolve to false", () => {
    setRemoteGovernanceSettings(null);

    // Note: "" (empty string) is treated as unset → true, see dedicated test below.
    for (const variant of ["false", "0", "off", "no", "random"]) {
      process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT = variant;
      const result = getRemoteGovernanceSettings(habitatId);
      expect(result).toEqual({
        applyInterceptorsToRemote: false,
        enforceHostApprovedCapability: false,
      });
    }
  });

  it("empty-string env is treated as unset → both flags default true", () => {
    setRemoteGovernanceSettings(null);

    process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT = "";
    const result = getRemoteGovernanceSettings(habitatId);
    expect(result).toEqual({
      applyInterceptorsToRemote: true,
      enforceHostApprovedCapability: true,
    });
  });
});
