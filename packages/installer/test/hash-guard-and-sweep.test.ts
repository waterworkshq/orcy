import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome } from "./helpers/setup.js";
import { uninstallAll } from "../src/lifecycle.js";
import { getContext } from "../src/context.js";
import { record, hashFile, hashDir } from "../src/manifest.js";

describe("P3.2: hash-guard for package.json (G4)", () => {
  it("should preserve package.json when modified since install", async () => {
    const pkgJsonPath = path.join(orcyHome(), "package.json");
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ dependencies: { foo: "1.0.0" } }, null, 2));
    record({ path: pkgJsonPath, action: "created", hash: hashFile(pkgJsonPath) });

    // User adds a dependency after install.
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify({ dependencies: { foo: "1.0.0", bar: "2.0.0" } }, null, 2),
    );

    await uninstallAll(getContext());

    expect(fs.existsSync(pkgJsonPath), "modified package.json preserved").toBe(true);
  });

  it("should remove package.json when hash matches install time", async () => {
    const pkgJsonPath = path.join(orcyHome(), "package.json");
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ dependencies: { foo: "1.0.0" } }, null, 2));
    record({ path: pkgJsonPath, action: "created", hash: hashFile(pkgJsonPath) });

    await uninstallAll(getContext());

    expect(fs.existsSync(pkgJsonPath), "unmodified package.json removed").toBe(false);
  });
});

describe("P3.2: hash-guard for skill dirs (G6)", () => {
  it("should preserve skill dir when modified since install", async () => {
    const skillDir = path.join(orcyHome(), "..", ".claude", "skills", "orcy-test");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# original content\n");
    record({ path: skillDir, action: "copied", hash: hashDir(skillDir) });

    // User edits the skill after install.
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# modified by user\n");

    await uninstallAll(getContext());

    expect(fs.existsSync(skillDir), "modified skill dir preserved").toBe(true);
  });

  it("should remove skill dir when hash matches install time", async () => {
    const skillDir = path.join(orcyHome(), "..", ".claude", "skills", "orcy-test");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# original content\n");
    record({ path: skillDir, action: "copied", hash: hashDir(skillDir) });

    await uninstallAll(getContext());

    expect(fs.existsSync(skillDir), "unmodified skill dir removed").toBe(false);
  });
});

describe("P3.3: G4 footprint sweep on uninstall", () => {
  it("should sweep src/, cache/, node_modules/ on uninstall", async () => {
    const srcDir = path.join(orcyHome(), "src", "orcy");
    const cacheDir = path.join(orcyHome(), "cache");
    const nodeModulesDir = path.join(orcyHome(), "node_modules");

    // Seed the disposable build artifacts.
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "file.txt"), "source checkout");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "orcy.tar.gz"), "fake archive");
    fs.mkdirSync(path.join(nodeModulesDir, "transitive-dep"), { recursive: true });
    fs.writeFileSync(
      path.join(nodeModulesDir, "transitive-dep", "index.js"),
      "module.exports = {};",
    );

    // Minimal manifest entry so uninstallAll proceeds (manifest must exist).
    const dummyPath = path.join(orcyHome(), "dummy");
    fs.writeFileSync(dummyPath, "dummy");
    record({ path: dummyPath, action: "created" });

    await uninstallAll(getContext());

    expect(fs.existsSync(path.join(orcyHome(), "src")), "src/ swept").toBe(false);
    expect(fs.existsSync(cacheDir), "cache/ swept").toBe(false);
    expect(fs.existsSync(nodeModulesDir), "node_modules/ swept").toBe(false);
  });
});
