import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { detectClis, SUPPORTED_CLIS } from "../src/detector.js";

describe("detector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects all five CLIs when available", () => {
    (execFileSync as any).mockImplementation((bin: string) => {
      if (bin === "which") return `/usr/local/bin/${process.argv[1] ?? bin}\n`;
      return `${bin} v1.2.3\n`;
    });

    const detected = detectClis();
    expect(detected).toHaveLength(5);
    expect(detected.map((c) => c.type)).toEqual(SUPPORTED_CLIS.map((c) => c.type));
  });

  it("extracts version from output", () => {
    (execFileSync as any).mockImplementation((bin: string) => {
      if (bin === "which") return `/usr/local/bin/${bin}\n`;
      return "claude-code 2.1.0 (build 1234)\n";
    });

    const detected = detectClis();
    expect(detected[0].version).toBe("2.1.0");
  });

  it("sets version to null when not parseable", () => {
    (execFileSync as any).mockImplementation((bin: string) => {
      if (bin === "which") return `/usr/local/bin/${bin}\n`;
      return "some output without version\n";
    });

    const detected = detectClis();
    expect(detected[0].version).toBeNull();
  });

  it("skips CLIs that are not found", () => {
    let callCount = 0;
    (execFileSync as any).mockImplementation((bin: string) => {
      callCount++;
      if (bin === "claude") return "claude 1.0.0\n";
      if (bin === "which") return `/usr/local/bin/${bin}\n`;
      throw new Error("not found");
    });

    const detected = detectClis();
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe("claude-code");
  });

  it("returns empty array when nothing is found", () => {
    (execFileSync as any).mockImplementation(() => {
      throw new Error("not found");
    });

    const detected = detectClis();
    expect(detected).toHaveLength(0);
  });

  it("falls back to bin name when which fails", () => {
    (execFileSync as any).mockImplementation((bin: string, args: string[]) => {
      if (args[0] === "--version") return "1.0.0\n";
      throw new Error("not found");
    });

    const detected = detectClis();
    expect(detected[0].path).toBe("claude");
  });
});
