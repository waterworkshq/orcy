import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Force a darwin platform so the wizard dispatches to installLaunchd.
vi.mock("../src/context.js", async () => {
  const shared = await import("@orcy/shared");
  const os = await import("node:os");
  const npath = await import("node:path");
  return {
    getContext: () => ({
      orcyHome: shared.ORCY_PATHS.home,
      binDir: shared.ORCY_PATHS.bin,
      uiDir: shared.ORCY_PATHS.ui,
      runDir: shared.ORCY_PATHS.run,
      logsDir: shared.ORCY_PATHS.logs,
      apiUrl: shared.getOrcyConfig().apiUrl,
      platform: "darwin" as NodeJS.Platform,
      shell: npath.basename(process.env.SHELL || "bash"),
      homeDir: os.homedir(),
    }),
  };
});

import "./helpers/setup.js";
import { wizard } from "../src/wizard.js";
import { tempHome } from "./helpers/setup.js";

describe("P2.2 (B3/G7): macOS launchd service installation", () => {
  it("should install a launchd plist with crash-only KeepAlive on darwin via wizard", async () => {
    await wizard({
      components: ["cli", "api"],
      mcpClients: [],
      patchFiles: [],
      skillRoots: [],
      interactive: false,
    });

    // The plist exists — proving the wizard reached installService on darwin
    // (previously the `=== 'linux'` gate silently dropped macOS).
    const plistPath = path.join(
      tempHome(),
      "Library",
      "LaunchAgents",
      "ai.orcy.api.plist",
    );
    expect(fs.existsSync(plistPath), "launchd plist created on darwin").toBe(
      true,
    );

    const plist = fs.readFileSync(plistPath, "utf-8");

    // G7: crash-only KeepAlive — restart on non-zero exit, NOT unconditionally.
    expect(
      plist,
      "must NOT contain unconditional KeepAlive=true",
    ).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist, "must contain crash-only KeepAlive dict").toContain(
      "SuccessfulExit",
    );
    expect(
      plist,
      "SuccessfulExit must be false (restart only on crash)",
    ).toContain("<false/>");

    // RunAtLoad should still be true (start on login).
    expect(plist).toContain("RunAtLoad");
  });

  it("should guard launchctl bootstrap with a loaded-check (idempotency)", () => {
    // Source-level assertion: the test harness mocks launchctl as always-success,
    // so the runtime guard path can't be observed. Assert the guard exists.
    const srcPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "service-installer.ts",
    );
    const src = fs.readFileSync(srcPath, "utf-8");
    expect(src).toContain("launchctl print");
    expect(src).toContain("launchctl bootstrap");
  });
});
