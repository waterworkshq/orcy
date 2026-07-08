import { describe, it, expect, vi, beforeEach } from "vitest";

const TOKEN = "test-jwt-token";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("orcy_token", TOKEN);
});

async function loadApi() {
  const mod = await import("./index.js");
  return mod.api;
}

function jsonOk(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

describe("api.auth", () => {
  describe("login (existing)", () => {
    it("POSTs to /auth/login with credentials", async () => {
      const api = await loadApi();
      const response = { token: "t", user: { id: "1", username: "admin", role: "admin" } };
      fetchMock.mockReturnValue(jsonOk(response));

      const result = await api.auth.login({ username: "admin", password: "pass" });

      expect(result).toEqual(response);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/login",
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toEqual({ username: "admin", password: "pass" });
    });
  });

  describe("setupStatus", () => {
    it("GETs /auth/setup-status and returns needsSetup", async () => {
      const api = await loadApi();
      fetchMock.mockReturnValue(jsonOk({ needsSetup: true }));

      const result = await api.auth.setupStatus();

      expect(result).toEqual({ needsSetup: true });
      expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/setup-status");
    });
  });

  describe("register", () => {
    it("POSTs to /auth/register with user data", async () => {
      const api = await loadApi();
      const response = {
        token: "new-token",
        user: { id: "2", username: "newuser", role: "admin", displayName: "New User" },
      };
      fetchMock.mockReturnValue(jsonOk(response));

      const result = await api.auth.register({
        username: "newuser",
        password: "pass123",
        displayName: "New User",
      });

      expect(result).toEqual(response);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/register",
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toEqual({ username: "newuser", password: "pass123", displayName: "New User" });
    });
  });

  describe("me", () => {
    it("GETs /auth/me with auth token and returns user", async () => {
      const api = await loadApi();
      const response = {
        user: { id: "1", username: "admin", role: "admin", displayName: "Admin" },
      };
      fetchMock.mockReturnValue(jsonOk(response));

      const result = await api.auth.me();

      expect(result).toEqual(response);
      const callOpts = fetchMock.mock.calls[0][1];
      expect(callOpts.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });
  });

  describe("logout", () => {
    it("POSTs to /auth/logout with auth token", async () => {
      const api = await loadApi();
      fetchMock.mockReturnValue(jsonOk({ success: true }));

      const result = await api.auth.logout();

      expect(result).toEqual({ success: true });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/logout",
        expect.objectContaining({ method: "POST" }),
      );
      const callOpts = fetchMock.mock.calls[0][1];
      expect(callOpts.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });
  });

  describe("changePassword", () => {
    it("POSTs to /auth/change-password with both passwords", async () => {
      const api = await loadApi();
      fetchMock.mockReturnValue(jsonOk({ success: true }));

      const result = await api.auth.changePassword({
        currentPassword: "old",
        newPassword: "new123",
      });

      expect(result).toEqual({ success: true });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/change-password",
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toEqual({ currentPassword: "old", newPassword: "new123" });
      const callOpts = fetchMock.mock.calls[0][1];
      expect(callOpts.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });
  });

  describe("updateProfile", () => {
    it("PATCHes /auth/me with displayName", async () => {
      const api = await loadApi();
      const response = {
        user: { id: "1", username: "admin", role: "admin", displayName: "Updated" },
      };
      fetchMock.mockReturnValue(jsonOk(response));

      const result = await api.auth.updateProfile({ displayName: "Updated" });

      expect(result).toEqual(response);
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/me",
        expect.objectContaining({ method: "PATCH" }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body).toEqual({ displayName: "Updated" });
      const callOpts = fetchMock.mock.calls[0][1];
      expect(callOpts.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    });
  });
});

describe("domain behavior", () => {
  it("reviewersApi.list fetches the correct endpoint", async () => {
    const { reviewersApi } = await import("./domains/reviewers.js");
    fetchMock.mockReturnValue(jsonOk({ reviewers: [] }));

    await reviewersApi.list("task-1");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/tasks/task-1/reviewers");
  });
});
