import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../repositories/daemon.js", () => ({
  getDaemonByTokenHash: vi.fn(),
}));
vi.mock("../lib/daemonToken.js", () => ({
  hashDaemonToken: (t: string) => `hash:${t}`,
}));
vi.mock("../errors.js", () => ({
  unauthorized: (msg: string, code: string) => {
    const err = new Error(msg);
    (err as any).statusCode = 401;
    (err as any).code = code;
    return err;
  },
}));

import { daemonAuth } from "../middleware/daemonAuth.js";
import * as daemonRepo from "../repositories/daemon.js";

function mockRequest(headers: Record<string, string | undefined> = {}) {
  return {
    headers,
    daemon: undefined,
  } as any;
}

function mockReply() {
  return {} as any;
}

describe("daemonAuth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects request without X-Daemon-Token header", async () => {
    await expect(daemonAuth(mockRequest(), mockReply())).rejects.toThrow("Missing X-Daemon-Token");
  });

  it("rejects invalid daemon token", async () => {
    vi.mocked(daemonRepo.getDaemonByTokenHash).mockReturnValue(null);
    await expect(daemonAuth(mockRequest({ "x-daemon-token": "bad" }), mockReply())).rejects.toThrow(
      "Invalid daemon token",
    );
  });

  it("sets request.daemon on valid token", async () => {
    vi.mocked(daemonRepo.getDaemonByTokenHash).mockReturnValue({
      id: "d1",
      name: "ws",
      hostname: "host",
      status: "online",
      maxConcurrent: 4,
    } as any);
    const req = mockRequest({ "x-daemon-token": "daemon-valid" });
    await daemonAuth(req, mockReply());
    expect(req.daemon).toBeDefined();
    expect(req.daemon!.id).toBe("d1");
    expect(req.daemon!.name).toBe("ws");
    expect(req.daemon!.maxConcurrent).toBe(4);
    expect(daemonRepo.getDaemonByTokenHash).toHaveBeenCalledWith("hash:daemon-valid");
  });

  it("hashes token before lookup", async () => {
    vi.mocked(daemonRepo.getDaemonByTokenHash).mockReturnValue({
      id: "d1",
      name: "ws",
      hostname: "host",
      status: "online",
      maxConcurrent: 4,
    } as any);
    await daemonAuth(mockRequest({ "x-daemon-token": "my-token" }), mockReply());
    expect(daemonRepo.getDaemonByTokenHash).toHaveBeenCalledWith("hash:my-token");
  });
});
