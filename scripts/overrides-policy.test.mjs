// Regression check for the pnpm overrides policy (pinned pnpm 9 reads
// `pnpm.overrides`, not the npm-style top-level `overrides`): the manifest
// must declare the policy where the pinned pnpm consumes it, and every
// version the lockfile resolved for an overridden package must satisfy the
// declared floor. Run: node --test scripts/ (or pnpm test:scripts).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Every strict `pkg@X.Y.Z` occurrence in lockfile-shaped text. */
function lockedVersions(text, pkg) {
  const re = new RegExp(`(?:^|[\\s'"'/])${escapeRegExp(pkg)}@(\\d+\\.\\d+\\.\\d+)`, "gm");
  return [...text.matchAll(re)].map((match) => match[1]);
}

/** `version` satisfies a `^major.minor.patch` floor. */
function satisfiesFloor(version, floor) {
  const base = floor.replace(/^\^/, "").split(".").map(Number);
  const value = version.split(".").map(Number);
  if (value[0] !== base[0]) return false;
  for (let i = 1; i < base.length; i++) {
    if (value[i] !== base[i]) return value[i] > base[i] || value[i - 1] > base[i - 1];
  }
  return true;
}

test("the resolution policy is declared under pnpm.overrides, not the ineffective top-level field", async () => {
  const manifest = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
  assert.equal(
    manifest.overrides,
    undefined,
    "top-level `overrides` is npm syntax; pinned pnpm 9 silently ignores it — declare the policy under `pnpm.overrides`",
  );
  assert.equal(typeof manifest.pnpm?.overrides, "object");
  assert.notEqual(Object.keys(manifest.pnpm.overrides).length, 0);
});

test("every locked version of an overridden package satisfies the declared floor", async () => {
  const manifest = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
  const lockfile = await readFile(`${root}/pnpm-lock.yaml`, "utf8");
  for (const [pkg, floor] of Object.entries(manifest.pnpm.overrides)) {
    const versions = [...new Set(lockedVersions(lockfile, pkg))];
    assert.notEqual(versions.length, 0, `no locked versions found for ${pkg} — name drifted?`);
    for (const version of versions) {
      assert.ok(
        satisfiesFloor(version, floor),
        `${pkg}@${version} violates the declared ${floor} floor — the override is not being consumed`,
      );
    }
  }
});

test("the floor checker detects the historical drift it exists to catch", () => {
  assert.deepEqual(lockedVersions("hono@4.12.10:\n  esbuild@0.27.7", "hono"), ["4.12.10"]);
  assert.equal(lockedVersions("postcss-load-config@6.0.1", "postcss").length, 0);
  assert.equal(satisfiesFloor("4.12.10", "^4.12.16"), false);
  assert.equal(satisfiesFloor("4.13.13", "^4.12.16"), true);
  assert.equal(satisfiesFloor("8.5.13", "^8.5.13"), true);
});