import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { request, requestBlob, uploadFile } from "./transport.js";

const TOKEN = "test-jwt-token";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("orcy_token", TOKEN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function jsonOk(body: unknown, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    statusText: "OK",
    json: () => Promise.resolve(body),
  });
}

function jsonErr(body: unknown, status: number, statusText = "Error") {
  return Promise.resolve({
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve(body),
  });
}

describe("transport.request", () => {
  it("injects Authorization header when token is present", async () => {
    fetchMock.mockReturnValue(jsonOk({ ok: true }));

    await request("/ping");

    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it("adds JSON Content-Type when a body is present", async () => {
    fetchMock.mockReturnValue(jsonOk({ ok: true }));

    await request("/ping", { method: "POST", body: JSON.stringify({ a: 1 }) });

    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("does not add Content-Type when there is no body", async () => {
    fetchMock.mockReturnValue(jsonOk({ ok: true }));

    await request("/ping");

    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers).not.toHaveProperty("Content-Type");
  });

  it("prefixes /api for normal paths and leaves /sse paths untouched", async () => {
    fetchMock.mockReturnValue(jsonOk({ ok: true }));
    await request("/tasks");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/tasks");

    fetchMock.mockReturnValue(jsonOk({ ok: true }));
    await request("/sse/presence/join");
    expect(fetchMock.mock.calls[1][0]).toBe("/sse/presence/join");
  });

  it("resolves {} on HTTP 204", async () => {
    fetchMock.mockReturnValue(jsonOk({}, 204));

    const result = await request("/thing", { method: "DELETE" });

    expect(result).toEqual({});
  });

  it("throws parsed error message on non-ok JSON response", async () => {
    fetchMock.mockReturnValue(jsonErr({ error: "nope" }, 400));

    await expect(request("/thing")).rejects.toThrow("nope");
  });

  it("falls back to HTTP <status> when error field is absent", async () => {
    fetchMock.mockReturnValue(jsonErr({}, 500));

    await expect(request("/thing")).rejects.toThrow("HTTP 500");
  });

  it("falls back to statusText when response body is not valid JSON", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: () => Promise.reject(new Error("not JSON")),
      }),
    );

    await expect(request("/thing")).rejects.toThrow("Bad Gateway");
  });
});

describe("transport.requestBlob", () => {
  it("returns { blob, headers } from the response", async () => {
    const blob = new Blob(["data"]);
    const headers = new Headers({ "content-disposition": 'attachment; filename="f.bin"' });
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(blob),
        headers,
      }),
    );

    const result = await requestBlob("/attachments/1");

    expect(result.blob).toBe(blob);
    expect(result.headers).toBe(headers);
  });

  it("throws parsed error message on non-ok response", async () => {
    fetchMock.mockReturnValue(jsonErr({ error: "missing" }, 404));

    await expect(requestBlob("/attachments/1")).rejects.toThrow("missing");
  });
});

function stubUploadXhr(opts: {
  status?: number;
  responseText?: string;
  fireOnSend?: "load" | "error" | "abort";
  fireProgress?: { loaded: number; total: number };
}) {
  const listeners: Record<string, EventListener> = {};
  const uploadListeners: Record<string, EventListener> = {};
  const instance = {
    status: opts.status ?? 200,
    responseText: opts.responseText ?? "{}",
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    upload: {
      addEventListener: (event: string, fn: EventListener) => {
        uploadListeners[event] = fn;
      },
    },
    addEventListener: (event: string, fn: EventListener) => {
      listeners[event] = fn;
    },
    send: vi.fn(() => {
      if (opts.fireProgress) {
        Promise.resolve().then(() =>
          uploadListeners.progress?.({
            lengthComputable: true,
            loaded: opts.fireProgress!.loaded,
            total: opts.fireProgress!.total,
          } as unknown as Event),
        );
      }
      const evt = opts.fireOnSend ?? "load";
      Promise.resolve().then(() => listeners[evt]?.({} as Event));
    }),
  };
  function MockXHR() {
    return instance;
  }
  vi.stubGlobal("XMLHttpRequest", MockXHR);
  return instance;
}

describe("transport.uploadFile", () => {
  it("uploads via XHR with auth header and resolves parsed JSON", async () => {
    const xhr = stubUploadXhr({ status: 200, responseText: JSON.stringify({ id: "9" }) });

    const result = await uploadFile<{ id: string }>("/attachments", new File(["x"], "f.txt"));

    expect(xhr.open).toHaveBeenCalledWith("POST", "/api/attachments");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("Authorization", `Bearer ${TOKEN}`);
    expect(result).toEqual({ id: "9" });
  });

  it("rejects with body error on non-2xx", async () => {
    stubUploadXhr({ status: 403, responseText: JSON.stringify({ error: "forbidden" }) });

    await expect(uploadFile("/attachments", new File(["x"], "f.txt"))).rejects.toThrow("forbidden");
  });

  it("rejects with 'Upload failed' on error event", async () => {
    stubUploadXhr({ status: 0, fireOnSend: "error" });

    await expect(uploadFile("/attachments", new File(["x"], "f.txt"))).rejects.toThrow(
      "Upload failed",
    );
  });

  it("rejects with 'Upload aborted' on abort event", async () => {
    stubUploadXhr({ status: 0, fireOnSend: "abort" });

    await expect(uploadFile("/attachments", new File(["x"], "f.txt"))).rejects.toThrow(
      "Upload aborted",
    );
  });

  it("reports upload progress via onProgress callback", async () => {
    stubUploadXhr({
      status: 200,
      responseText: "{}",
      fireProgress: { loaded: 50, total: 100 },
    });

    const onProgress = vi.fn();
    await uploadFile("/attachments", new File(["x"], "f.txt"), onProgress);

    expect(onProgress).toHaveBeenCalledWith(50);
  });
});
