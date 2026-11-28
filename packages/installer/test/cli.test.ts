/**
 * resolveAction dispatch logic — test suite.
 *
 * Tests the pure resolveAction helper extracted from main(). No process
 * spawning needed — resolveAction takes raw argv and returns an Action
 * discriminated union, making every dispatch decision unit-testable.
 *
 * MOCK BOUNDARY: imports ./helpers/setup.js FIRST (mocks @orcy/shared
 * ORCY_PATHS, node:child_process, fetch) — required because importing
 * index.ts pulls in modules that capture ORCY_PATHS at load time.
 */
import { describe, it, expect } from "vitest";
import "./helpers/setup.js";
import { resolveAction } from "../src/index.js";

describe("resolveAction — CLI dispatch", () => {
  it("(a) unknown command (typo) → error, NOT noninteractive-wizard", () => {
    const action = resolveAction(["updtae"]);
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      expect(action.message).toContain("updtae");
      expect(action.message).toContain("--help");
    }
  });

  it("(b) --yes → recognized noninteractive-wizard with yes:true", () => {
    const action = resolveAction(["--yes"]);
    expect(action.kind).toBe("noninteractive-wizard");
    if (action.kind === "noninteractive-wizard") {
      expect(action.opts["yes"]).toBe("true");
    }
  });

  it("(c) --components=cli,api → noninteractive-wizard with parsed opts", () => {
    const action = resolveAction(["--components=cli,api"]);
    expect(action.kind).toBe("noninteractive-wizard");
    if (action.kind === "noninteractive-wizard") {
      expect(action.opts["components"]).toBe("cli,api");
    }
  });

  it("(d) known commands → command", () => {
    for (const cmd of ["verify", "doctor", "update", "uninstall", "list", "service", "help"]) {
      expect(resolveAction([cmd]).kind).toBe("command");
    }
  });

  it("(e) no args → interactive-wizard", () => {
    expect(resolveAction([], { interactive: true }).kind).toBe("interactive-wizard");
  });

  it("(f) built-in flags → command", () => {
    for (const flag of ["--help", "-h", "--version", "-V"]) {
      expect(resolveAction([flag]).kind).toBe("command");
    }
  });

  it("(g) --yes combined with other options → noninteractive with both opts", () => {
    const action = resolveAction(["--yes", "--components=cli"]);
    expect(action.kind).toBe("noninteractive-wizard");
    if (action.kind === "noninteractive-wizard") {
      expect(action.opts["yes"]).toBe("true");
      expect(action.opts["components"]).toBe("cli");
    }
  });

  it("-y shorthand → recognized same as --yes", () => {
    const action = resolveAction(["-y"]);
    expect(action.kind).toBe("noninteractive-wizard");
    if (action.kind === "noninteractive-wizard") {
      expect(action.opts["yes"]).toBe("true");
    }
  });

  it("--local → recognized noninteractive-wizard", () => {
    const action = resolveAction(["--local"]);
    expect(action.kind).toBe("noninteractive-wizard");
    if (action.kind === "noninteractive-wizard") {
      expect(action.opts["local"]).toBe("true");
    }
  });

  it("unknown flag (not a wizard option) → error", () => {
    const action = resolveAction(["--bogus"]);
    expect(action.kind).toBe("error");
  });

  it("T4.3: a valid flag mixed with an unknown one → error (not silent install)", () => {
    // `--yes --bogus` must error, not silently install while ignoring --bogus.
    expect(resolveAction(["--yes", "--bogus"]).kind).toBe("error");
    expect(resolveAction(["--recover", "updtae"]).kind).toBe("error"); // positional junk
    // but a fully-valid combination still dispatches:
    expect(resolveAction(["--yes", "--recover", "--components=cli"]).kind).toBe(
      "noninteractive-wizard",
    );
  });

  it("no args on a non-interactive stdin → actionable error, not a wizard that cannot read answers", () => {
    // `curl … | bash` without a terminal, or CI: stdin is end-of-input, so the
    // wizard would print its first question and exit 0 having installed nothing.
    const action = resolveAction([], {
      interactive: false,
      entry: "/home/u/.orcy/installer/dist/index.js",
    });
    expect(action.kind).toBe("error");
    if (action.kind === "error") {
      // The way out runs exactly as printed: `orcy-install` is not on PATH.
      expect(action.message).toContain(
        "node '/home/u/.orcy/installer/dist/index.js' --yes --components=cli,api,mcp",
      );
    }
  });

  it("shell-quotes this program's path in the non-interactive command", () => {
    const action = resolveAction([], { interactive: false, entry: "/tmp/it's here/index.js" });
    expect(action.kind === "error" ? action.message : "").toContain(
      "node '/tmp/it'\\''s here/index.js' --yes --components=cli,api,mcp",
    );
  });

  it("names this module's own file when no entry path is given", () => {
    // `process.argv[1]` is undefined for `node -e` / stdin; the module's file is not.
    const action = resolveAction([], { interactive: false });
    expect(action.kind === "error" ? action.message : "").toContain(
      `node '${import.meta.filename.replace(/test\/cli\.test\.ts$/, "src/index.ts")}' --yes --components=cli,api,mcp`,
    );
  });

  it("a non-interactive stdin does not affect explicit non-interactive runs or commands", () => {
    expect(resolveAction(["--yes"], { interactive: false }).kind).toBe("noninteractive-wizard");
    expect(resolveAction(["doctor"], { interactive: false }).kind).toBe("command");
  });
});
