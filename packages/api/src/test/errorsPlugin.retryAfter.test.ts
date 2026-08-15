/**
 * Error-handler Retry-After contract: a 503 AppError carrying `retryAfterMs`
 * (release-bootstrap contention, triage busy paths) must surface the header
 * so clients can honor backoff instead of reading a bare 500/503.
 */
import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandler } from "../errors/plugin.js";
import { AppError } from "../errors.js";

describe("error handler — Retry-After for retryable AppErrors", () => {
  it("a 503 AppError with retryAfterMs returns 503 + Retry-After + typed code", async () => {
    const app: FastifyInstance = Fastify({ logger: false });
    await registerErrorHandler(app);
    app.get("/busy", async () => {
      const err = new AppError(
        503,
        "SERVICE_UNAVAILABLE",
        "release bootstrap contention; retry after 250ms",
      );
      err.retryAfterMs = 250;
      throw err;
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/busy" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("1"); // ceil(250/1000), min 1s
    expect(res.json().code).toBe("SERVICE_UNAVAILABLE");
    await app.close();
  });

  it("an AppError without retryAfterMs emits no Retry-After header", async () => {
    const app: FastifyInstance = Fastify({ logger: false });
    await registerErrorHandler(app);
    app.get("/plain", async () => {
      throw new AppError(409, "CONFLICT", "plain conflict");
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/plain" });
    expect(res.statusCode).toBe(409);
    expect(res.headers["retry-after"]).toBeUndefined();
    await app.close();
  });

  it("a non-503 AppError carrying retryAfterMs emits no Retry-After header", async () => {
    const app: FastifyInstance = Fastify({ logger: false });
    await registerErrorHandler(app);
    app.get("/not-retryable", async () => {
      // A mis-set hint on a non-retryable status must not advertise retry.
      const err = new AppError(409, "CONFLICT", "conflict with a stray hint");
      err.retryAfterMs = 250;
      throw err;
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/not-retryable" });
    expect(res.statusCode).toBe(409);
    expect(res.headers["retry-after"]).toBeUndefined();
    await app.close();
  });
});
