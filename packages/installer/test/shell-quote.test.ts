/**
 * Shell quoting for commands the installer prints for the user to re-run.
 *
 * The proof is a real shell: each quoted value is passed through `sh -c` to
 * `printf '%s'` and must come back byte for byte, whatever it contains.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { shellQuote, shellWord } from "../src/shell-quote.js";

function shellEcho(quoted: string): string {
  const r = spawnSync("sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  return r.stdout;
}

describe("shell quoting", () => {
  it.each([
    "/tmp/plain/dist/index.js",
    "/tmp/my home/.orcy/installer/dist/index.js",
    "/tmp/it's here/index.js",
    "$(rm -rf /tmp/nothing) `id`",
    "* ? [a-z] ~user",
    "line1\nline2",
    "",
  ])("round-trips %j through a POSIX shell", (value) => {
    expect(shellEcho(shellQuote(value))).toBe(value);
  });

  it("leaves plain words as they are and quotes only what a shell would read differently", () => {
    expect(
      ["corepack", "pnpm@10.34.8", "--filter", "./packages/installer", "deploy", "--prod"].map(shellWord),
    ).toEqual(["corepack", "pnpm@10.34.8", "--filter", "./packages/installer", "deploy", "--prod"]);
    expect(shellWord("/tmp/my home/.orcy/installer.new")).toBe("'/tmp/my home/.orcy/installer.new'");
    expect(shellEcho(shellWord("it's"))).toBe("it's");
  });
});
