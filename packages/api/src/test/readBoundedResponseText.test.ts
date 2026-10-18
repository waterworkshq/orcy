import { describe, expect, it, vi } from "vitest";
import { readBoundedResponseText } from "../utils/readBoundedResponseText.js";

const encode = (text: string) => new TextEncoder().encode(text);
function chunks(values: Uint8Array[], cancel = vi.fn()) {
  let index = 0;
  let exposedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const value = values[index++];
      if (!value) { controller.close(); return; }
      exposedBytes += value.byteLength;
      controller.enqueue(value);
    },
    cancel,
  }, { highWaterMark: 0 });
  return { response: new Response(body), body, cancel, exposedBytes: () => exposedBytes };
}

describe("webhook diagnostic response prefix", () => {
  it("accepts a response without a body", async () => {
    await expect(readBoundedResponseText(new Response(null, { status: 204 }))).resolves.toBe("");
  });

  it.each([0, 1, 8191, 8192, 8193])("retains the bounded prefix of a %i-byte body and releases the lock", async (size) => {
    const stream = chunks(size ? [encode("x".repeat(size))] : []);
    await expect(readBoundedResponseText(stream.response)).resolves.toBe("x".repeat(Math.min(size, 8192)));
    expect(stream.cancel).toHaveBeenCalledTimes(size >= 8192 ? 1 : 0);
    expect(stream.body.locked).toBe(false);
  });

  it("does not retain an oversized transport chunk's tail", async () => {
    const stream = chunks([encode("a".repeat(8192) + "TAIL".repeat(16384)), encode("unread")]);
    await expect(readBoundedResponseText(stream.response)).resolves.toBe("a".repeat(8192));
    // The transport exposed the whole first chunk. This is deliberately not a
    // claim that only 8192 network bytes were received or allocated by fetch.
    expect(stream.exposedBytes()).toBe(73728);
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it("stops a nonclosing stream at the byte budget", async () => {
    let exposedBytes = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { exposedBytes += 257; controller.enqueue(encode("x".repeat(257))); },
      cancel,
    }, { highWaterMark: 0 });
    await expect(readBoundedResponseText(new Response(body))).resolves.toBe("x".repeat(8192));
    expect(exposedBytes).toBe(8224);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("decodes UTF-8 and the BOM across byte-sized chunks", async () => {
    const bytes = encode("\uFEFFé🙂漢字");
    const stream = chunks(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    await expect(readBoundedResponseText(stream.response)).resolves.toBe("é🙂漢字");
  });

  it.each([1, 2, 3])("omits a trailing partial four-byte codepoint with %i bytes left at cutoff", async (remaining) => {
    const stream = chunks([encode("x".repeat(8192 - remaining)), encode("🙂suffix")]);
    await expect(readBoundedResponseText(stream.response)).resolves.toBe("x".repeat(8192 - remaining));
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it("keeps a multibyte codepoint ending exactly at the byte budget", async () => {
    const stream = chunks([encode("x".repeat(8188)), Uint8Array.of(0xf0, 0x9f), Uint8Array.of(0x99, 0x82)]);
    await expect(readBoundedResponseText(stream.response)).resolves.toBe("x".repeat(8188) + "🙂");
  });

  it("uses replacement decoding for malformed bytes and incomplete ordinary EOF", async () => {
    const stream = chunks([Uint8Array.of(0xff, 0x61, 0xe2, 0x82)]);
    await expect(readBoundedResponseText(stream.response)).resolves.toBe("�a�");
    expect(stream.cancel).not.toHaveBeenCalled();
  });

  it("retains replacement for malformed sequences before cutoff", async () => {
    const stream = chunks([encode("x".repeat(8190)), Uint8Array.of(0xff, 0xff, 0x61)]);
    await expect(readBoundedResponseText(stream.response)).resolves.toBe("x".repeat(8190) + "��");
  });

  it("propagates a genuine read failure and releases the reader", async () => {
    const failure = new Error("body connection reset");
    let first = true;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (first) { first = false; controller.enqueue(encode("prefix")); }
      else controller.error(failure);
    } }, { highWaterMark: 0 });
    await expect(readBoundedResponseText(new Response(body))).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });

  it("observes cancellation rejection without losing the response prefix", async () => {
    const stream = chunks([encode("x".repeat(8193))], vi.fn().mockRejectedValue(new Error("cancel failed")));
    await expect(readBoundedResponseText(stream.response)).resolves.toBe("x".repeat(8192));
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(stream.body.locked).toBe(false);
    await Promise.resolve(); // Any unhandled rejection fails Vitest.
  });

  it("does not wait for underlying cancellation to settle", async () => {
    const stream = chunks([encode("x".repeat(8193))], vi.fn(() => new Promise<void>(() => undefined)));
    await expect(readBoundedResponseText(stream.response)).resolves.toBe("x".repeat(8192));
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(stream.body.locked).toBe(false);
  });
});
