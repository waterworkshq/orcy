import { describe, it, expect } from "vitest";
import { redact, redactObject } from "../src/redact.js";

describe("redact", () => {
  it("redacts daemon tokens", () => {
    const input = "Got token daemon-0123456789abcdef0123456789abcdef0123456789abcdef for daemon";
    expect(redact(input)).toBe("Got token [REDACTED] for daemon");
  });

  it("redacts agent API keys", () => {
    const input =
      "Agent key is 00000000-0000-0000-0000-000000000001-abcdef0123456789abcdef0123456789";
    expect(redact(input)).toBe("Agent key is [REDACTED]");
  });

  it("leaves non-sensitive content intact", () => {
    const input = "Daemon ws-1 heartbeat at 2026-05-28T12:00:00Z";
    expect(redact(input)).toBe(input);
  });

  it("redacts multiple tokens in one string", () => {
    const input =
      "daemon-0123456789abcdef0123456789abcdef0123456789abcdef daemon-fedcba9876543210fedcba9876543210fedcba9876543210";
    const result = redact(input);
    expect(result).toBe("[REDACTED] [REDACTED]");
  });

  it("redactObject redacts inside JSON", () => {
    const obj = {
      token: "daemon-0123456789abcdef0123456789abcdef0123456789abcdef",
      name: "ws",
    };
    const result = redactObject(obj);
    expect(result.token).toBe("[REDACTED]");
    expect(result.name).toBe("ws");
  });
});
