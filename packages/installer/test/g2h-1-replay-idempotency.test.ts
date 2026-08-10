/**
 * G2H.1 — replay idempotency + dedup metadata merge (cold-review Tier 1, T1.2).
 *
 * Locks in the three fixes: (1) record/recordStep/commitJournal upsert metadata
 * instead of first-wins dropping it (so a refreshed hash survives); (2) skill
 * replay preserves user-modified dirs (G6); (3) env replay updates managed
 * endpoint fields while preserving secrets.
 *
 * MOCK BOUNDARY: imports ./helpers/setup.js FIRST.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import "./helpers/setup.js";
import { orcyHome } from "./helpers/setup.js";
import { getContext } from "../src/context.js";
import { record, readManifest } from "../src/manifest.js";
import { installSkills } from "../src/skill-installer.js";
import { generateEnvFile } from "../src/env-bootstrap.js";

describe("G2H.1 — dedup metadata merge (record upserts, not first-wins)", () => {
  it("re-record with a changed hash refreshes the entry instead of dropping it", () => {
    const p = path.join(orcyHome(), "bin", "orcy");
    record({ path: p, action: "created" });
    record({ path: p, action: "created", hash: "hash-1" });

    let m = readManifest()!;
    const entry = m.files.find((f) => f.path === p && f.action === "created")!;
    expect(entry.hash).toBe("hash-1");

    // A later update recomputes the hash — it must replace hash-1, not be ignored.
    record({ path: p, action: "created", hash: "hash-2" });
    m = readManifest()!;
    const refreshed = m.files.find((f) => f.path === p && f.action === "created")!;
    expect(refreshed.hash).toBe("hash-2");
    // Still exactly one entry (no duplicate appended).
    expect(m.files.filter((f) => f.path === p && f.action === "created").length).toBe(1);
  });

  it("re-record with undefined metadata never clobbers existing fields", () => {
    const p = path.join(orcyHome(), "bin", "orcy-api");
    record({ path: p, action: "created", hash: "keep-me", backup: "/b" });
    // A later record() that omits hash/backup must not erase them.
    record({ path: p, action: "created" });
    const entry = readManifest()!.files.find((f) => f.path === p && f.action === "created")!;
    expect(entry.hash).toBe("keep-me");
    expect(entry.backup).toBe("/b");
  });
});

describe("G2H.1 — skill replay preserves user-modified dirs (G6)", () => {
  it("re-install overwrites when the skill is unchanged (refresh)", () => {
    const root = path.join(orcyHome(), "skills");
    installSkills(getContext(), [root], ["orcy-overview"]);
    const dest = path.join(root, "orcy-overview");
    const skillFile = path.join(dest, "SKILL.md");
    const original = fs.readFileSync(skillFile, "utf-8");

    // No modification → re-install refreshes (same content) without preserving-as-modified.
    installSkills(getContext(), [root], ["orcy-overview"]);
    expect(fs.readFileSync(skillFile, "utf-8")).toBe(original);
  });

  it("re-install preserves a user-modified skill dir instead of overwriting", () => {
    const root = path.join(orcyHome(), "skills");
    installSkills(getContext(), [root], ["orcy-cli-usage"]);
    const dest = path.join(root, "orcy-cli-usage");

    // Simulate a user edit (changes the dir hash).
    fs.appendFileSync(path.join(dest, "SKILL.md"), "\n<!-- user edit -->\n");

    const beforeEdit = fs.readFileSync(path.join(dest, "SKILL.md"), "utf-8");
    installSkills(getContext(), [root], ["orcy-cli-usage"]);
    // User edit preserved — not overwritten by the re-install.
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf-8")).toBe(beforeEdit);
  });
});

describe("G2H.1 — env replay updates managed endpoint fields, preserves secrets", () => {
  it("update applies a changed port/host while keeping existing secrets", () => {
    const envPath = path.join(orcyHome(), ".env");
    // Seed an existing .env with both secrets + an old endpoint.
    fs.writeFileSync(
      envPath,
      [
        "PORT=9999",
        "HOST=0.0.0.0",
        "JWT_SECRET=secret-keep-me",
        "ORCY_REGISTRATION_TOKEN=token-keep-me",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    generateEnvFile(getContext(), { port: 4000, host: "127.0.0.1" });

    const after = fs.readFileSync(envPath, "utf-8");
    // Managed endpoint fields reflect the new intent.
    expect(after).toContain("PORT=4000");
    expect(after).toContain("HOST=127.0.0.1");
    expect(after).toContain("ORCY_API_URL=http://127.0.0.1:4000");
    // Secrets preserved (not regenerated).
    expect(after).toContain("JWT_SECRET=secret-keep-me");
    expect(after).toContain("ORCY_REGISTRATION_TOKEN=token-keep-me");
  });
});
