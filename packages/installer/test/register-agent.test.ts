import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import "./helpers/setup.js";
import { createJournal, readJournal, discardJournal } from "../src/journal.js";
import { registerAgent } from "../src/credentials.js";
import { getContext } from "../src/context.js";

const credStep = () =>
  readJournal()?.steps.find((s) => s.path.endsWith("credentials.json")) ?? null;

describe("registerAgent G3 two-phase sub-stepping", () => {
  beforeEach(() => {
    createJournal();
  });
  afterEach(() => {
    discardJournal();
    vi.restoreAllMocks();
  });

  it("happy path: step progresses post → credentials → done", async () => {
    const creds = await registerAgent(getContext(), {});
    expect(creds).not.toBeNull();
    const step = credStep();
    expect(step).not.toBeNull();
    expect(step!.status).toBe("done");
    expect(step!.phase).toBe("credentials");
    expect(step!.phasePayload).toMatchObject({ agentId: "agent-test-001" });
  });

  it("POST rejected (403): step stays at phase 'post', pending, no agentId captured", async () => {
    (
      globalThis.fetch as unknown as { mockImplementationOnce: (fn: unknown) => void }
    ).mockImplementationOnce(async () => new Response("forbidden", { status: 403 }));
    const creds = await registerAgent(getContext(), {});
    expect(creds).toBeNull();
    const step = credStep();
    expect(step).not.toBeNull();
    expect(step!.status).toBe("pending");
    expect(step!.phase).toBe("post");
    expect(step!.phasePayload).toBeUndefined();
  });

  it("POST succeeds but credential write fails: step marked failed at phase 'credentials' WITH agentId, and rethrows (G2H.2)", async () => {
    // The distinguishing G3 state: the remote POST committed (agentId captured) but the
    // local credential write did not — compensation is owed. G2H.2: such a failure is
    // NOT swallowed; the step is marked failed (preserving the agentId) and the error
    // rethrown so the wizard aborts before commitJournal deletes the journal. Recovery
    // then sees phase 'credentials' + status !== 'done' → not viable → surfaces the orphan.
    const real = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, "writeFileSync");
    spy.mockImplementation(((p: unknown, d: unknown, o: unknown) => {
      if (String(p).endsWith("credentials.json")) throw new Error("disk full");
      return real(p as never, d as never, o as never);
    }) as never);
    await expect(registerAgent(getContext(), {})).rejects.toThrow("disk full");
    const step = credStep();
    expect(step).not.toBeNull();
    expect(step!.status).toBe("failed");
    expect(step!.phase).toBe("credentials");
    expect(step!.phasePayload).toMatchObject({ agentId: "agent-test-001" });
  });
});
