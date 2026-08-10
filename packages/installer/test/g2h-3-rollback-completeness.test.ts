/**
 * G2H.3 — rollback completeness (cold-review Tier 1, T1.3).
 *
 * Locks in: rollbackJournal stops a service the partial install started (when a
 * service-artifact step is present) BEFORE reversing files, mirroring
 * uninstallAll's B1 order. Detected via the execSync hook recording the
 * `systemctl --user stop` command that stopService issues.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome, setExecHook } from "./helpers/setup.js";
import { getContext } from "../src/context.js";
import { rollbackJournal } from "../src/lifecycle.js";
import type { Journal } from "../src/journal.js";

function journal(steps: Array<Record<string, unknown>>): Journal {
  return {
    version: 1,
    startedAt: "2024-01-01T00:00:00Z",
    components: [],
    steps: steps as unknown as Journal["steps"],
  };
}

afterEach(() => setExecHook(null));

describe("G2H.3 — rollbackJournal stops a started service", () => {
  it("issues a service stop when a service-artifact step is present, then reverses files", () => {
    const wrapper = path.join(orcyHome(), "bin", "orcy-api-wrapper");
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, "#!/bin/sh\n", { mode: 0o755 });
    const unitPath = path.join(
      // service-installer records under ~/.config/systemd/user/orcy-api.service; replicate here.
      orcyHome().replace(/\/\.orcy$/, ""),
      ".config",
      "systemd",
      "user",
      "orcy-api.service",
    );
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, "[Unit]\n", "utf-8");

    const commands: string[] = [];
    setExecHook((cmd: string) => {
      commands.push(cmd);
      return undefined; // fall through to default no-op handling
    });

    const result = rollbackJournal(
      getContext(),
      journal([
        { path: wrapper, action: "created", step: 0, status: "done", ts: "t" },
        { path: unitPath, action: "created", step: 1, status: "done", ts: "t" },
      ]),
    );

    // The service was stopped (B1 order) before file reversal.
    expect(commands.some((c) => /systemctl.*stop.*orcy-api/.test(c))).toBe(true);
    // Both artifacts reversed.
    expect(result.reversed).toBe(2);
    expect(result.failed).toBe(0);
    expect(fs.existsSync(wrapper)).toBe(false);
    expect(fs.existsSync(unitPath)).toBe(false);
  });

  it("does NOT issue a service stop when no service-artifact step is present", () => {
    const bin = path.join(orcyHome(), "bin", "orcy");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "bin", "utf-8");

    const commands: string[] = [];
    setExecHook((cmd: string) => {
      commands.push(cmd);
      return undefined;
    });

    rollbackJournal(
      getContext(),
      journal([{ path: bin, action: "created", step: 0, status: "done", ts: "t" }]),
    );

    expect(commands.some((c) => /systemctl.*stop.*orcy-api/.test(c))).toBe(false);
  });
});
