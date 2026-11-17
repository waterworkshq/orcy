// Regression check for the .gitignore blanket dot-directory rule (`.*/`):
// new files under .github/ must stay visible to git — the rule used to hide
// them until `git add -f` (landing .github/dependabot.yml), fixed by the
// `!.github/` negation. Run: node --test scripts/ (or pnpm test:scripts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** `git check-ignore` verdict for a path: true = ignored, false = visible. */
function isIgnored(path) {
  const result = spawnSync("git", ["check-ignore", "--", path], { cwd: root, encoding: "utf8" });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore failed for ${path}: ${result.stderr}`);
}

test("new files under .github/ are not ignored", () => {
  assert.equal(isIgnored(".github/guard-probe.yml"), false);
  assert.equal(isIgnored(".github/workflows/guard-probe.yml"), false);
});

test("the blanket dot-directory rule still holds outside the .github negation", () => {
  assert.equal(isIgnored(".guard-probe-dir/x"), true);
  assert.equal(isIgnored(".github/.guard-probe-cache/x"), true);
  // The negation is root-anchored (`!/.github/`): a dot-dir of the same name
  // nested under a package stays ignored by the blanket `.*/` rule.
  assert.equal(isIgnored("packages/guard-probe/.github/x"), true);
});
