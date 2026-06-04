import { describe, expect, it } from "vitest";
import { normalizeAuditActorAndSource } from "../services/auditProjectionNormalizer.js";

describe("audit projection normalizer", () => {
  it("normalizes legacy system actor ids in projection only", () => {
    expect(
      normalizeAuditActorAndSource({ actorType: "system", actorId: "status-engine" }),
    ).toMatchObject({
      actor: { type: "system", id: "system:status-engine" },
      source: "system",
    });

    expect(
      normalizeAuditActorAndSource({ actorType: "system", actorId: "github-ci" }),
    ).toMatchObject({
      actor: { type: "system", id: "system:github-ci" },
      source: "webhook",
    });
  });

  it("prefers explicit audit metadata source and provenance", () => {
    const normalized = normalizeAuditActorAndSource({
      actorType: "agent",
      actorId: "agent-1",
      actorName: "Builder",
      metadata: {
        audit: {
          source: "mcp_tool",
          toolName: "orcy_habitat_task",
          requestId: "req-1",
          method: "POST",
        },
      },
    });

    expect(normalized).toEqual({
      actor: { type: "agent", id: "agent-1", name: "Builder" },
      source: "mcp_tool",
      provenance: {
        requestId: "req-1",
        method: "POST",
        toolName: "orcy_habitat_task",
      },
    });
  });

  it("leaves unknown actor ids truthful instead of inventing source certainty", () => {
    expect(
      normalizeAuditActorAndSource({ actorType: "system", actorId: "mystery-engine" }),
    ).toMatchObject({
      actor: { type: "system", id: "mystery-engine" },
      source: "unknown",
      provenance: {},
    });
  });
});
