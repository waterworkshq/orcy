import { describe, it, expect } from "vitest";
import { generateDaemonToken, hashDaemonToken, verifyDaemonToken } from "../lib/daemonToken.js";

describe("daemonToken", () => {
  it("generates a token with daemon- prefix", () => {
    const token = generateDaemonToken();
    expect(token).toMatch(/^daemon-[0-9a-f]{48}$/);
  });

  it("generates unique tokens", () => {
    const a = generateDaemonToken();
    const b = generateDaemonToken();
    expect(a).not.toBe(b);
  });

  it("hashes deterministically", () => {
    const token = generateDaemonToken();
    const h1 = hashDaemonToken(token);
    const h2 = hashDaemonToken(token);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("different tokens produce different hashes", () => {
    const a = hashDaemonToken("daemon-aaa");
    const b = hashDaemonToken("daemon-bbb");
    expect(a).not.toBe(b);
  });

  it("verifyDaemonToken returns true for matching hash", () => {
    const token = generateDaemonToken();
    const hash = hashDaemonToken(token);
    expect(verifyDaemonToken(token, hash)).toBe(true);
  });

  it("verifyDaemonToken returns false for wrong token", () => {
    const hash = hashDaemonToken("daemon-correct");
    expect(verifyDaemonToken("daemon-wrong", hash)).toBe(false);
  });

  it("verifyDaemonToken returns false for wrong hash", () => {
    const token = generateDaemonToken();
    expect(verifyDaemonToken(token, "0000notahash")).toBe(false);
  });
});
