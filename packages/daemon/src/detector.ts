import { execFileSync } from "node:child_process";
import type { DetectedCli } from "./types.js";

const SUPPORTED_CLIS = [
  { type: "claude-code" as const, bin: "claude", versionArgs: ["--version"] },
  { type: "codex" as const, bin: "codex", versionArgs: ["--version"] },
  { type: "opencode" as const, bin: "opencode", versionArgs: ["--version"] },
  { type: "cursor" as const, bin: "cursor-agent", versionArgs: ["--version"] },
  { type: "gemini" as const, bin: "gemini", versionArgs: ["--version"] },
];

export function detectClis(): DetectedCli[] {
  const found: DetectedCli[] = [];

  for (const cli of SUPPORTED_CLIS) {
    try {
      const output = execFileSync(cli.bin, cli.versionArgs, {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      found.push({
        type: cli.type,
        version: extractVersion(output) || null,
        path: resolveBinPath(cli.bin),
      });
    } catch {
      continue;
    }
  }

  return found;
}

function extractVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function resolveBinPath(bin: string): string {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    return execFileSync(which, [bin], { encoding: "utf-8", timeout: 3000 }).trim().split("\n")[0];
  } catch {
    return bin;
  }
}

export { SUPPORTED_CLIS };
