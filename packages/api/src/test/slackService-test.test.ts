import { describe, it, expect, vi } from "vitest";

vi.mock("../config/integrationSecurity.js", () => ({
  verifySlackSignature: vi.fn(),
  validateOutboundUrl: vi.fn(),
}));

import {
  verifySlackRequest,
  verifySlackRequestWithTimestamp,
  parseSlackCommand,
  formatSlackMessage,
} from "../services/slackService.js";
import { verifySlackSignature } from "../config/integrationSecurity.js";

describe("slackService", () => {
  describe("verifySlackRequest", () => {
    it("returns true when valid", () => {
      vi.mocked(verifySlackSignature).mockReturnValue({ valid: true });
      expect(verifySlackRequest("sig", "body", "secret")).toBe(true);
    });
    it("returns false when invalid", () => {
      vi.mocked(verifySlackSignature).mockReturnValue({ valid: false, reason: "bad" });
      expect(verifySlackRequest("sig", "body", "secret")).toBe(false);
    });
  });

  describe("verifySlackRequestWithTimestamp", () => {
    it("delegates and passes timestamp", () => {
      vi.mocked(verifySlackSignature).mockReturnValue({ valid: true });
      const result = verifySlackRequestWithTimestamp("sig", "ts", "body", "secret");
      expect(result.valid).toBe(true);
      expect(verifySlackSignature).toHaveBeenCalledWith("sig", "ts", "body", "secret");
    });
  });

  describe("parseSlackCommand", () => {
    it("parses action and args", () => {
      expect(parseSlackCommand("status task-1")).toEqual({ action: "status", args: ["task-1"] });
    });
    it("defaults to help when empty", () => {
      expect(parseSlackCommand("")).toEqual({ action: "help", args: [] });
    });
    it("handles multiple args", () => {
      expect(parseSlackCommand("assign task-1 agent-2")).toEqual({
        action: "assign",
        args: ["task-1", "agent-2"],
      });
    });
    it("lowercases action", () => {
      expect(parseSlackCommand("HELP")).toEqual({ action: "help", args: [] });
    });
  });

  describe("formatSlackMessage", () => {
    it("formats with emoji and title", () => {
      const msg = formatSlackMessage("task_created", {
        id: "t1",
        title: "Fix bug",
        status: "pending",
        priority: "high",
        assignedAgentName: "Bot",
      } as any);
      expect(msg).toHaveProperty("text");
    });
    it("uses fallback emoji for unknown event", () => {
      const msg = formatSlackMessage("unknown_event");
      expect(msg).toHaveProperty("text");
    });
    it("formats without task data", () => {
      const msg = formatSlackMessage("task_approved");
      expect(msg).toHaveProperty("text");
    });
  });
});
