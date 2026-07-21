import { describe, expect, it } from "vitest";
import { ResponseTooLarge } from "../../src/core/errors";
import { DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS, parseRetryAfter, readBoundedResponse } from "../../src/core/http";

describe("bounded HTTP responses", () => {
  it("rejects both an oversized Content-Length and an oversized streamed body", async () => {
    await expect(readBoundedResponse(new Response("%PDF", {
      headers: { "content-length": "5" },
    }), 4)).rejects.toBeInstanceOf(ResponseTooLarge);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
        controller.close();
      },
    });
    await expect(readBoundedResponse(new Response(stream), 4)).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  it("returns bounded bodies unchanged", async () => {
    const body = await readBoundedResponse(new Response("%PDF"), 4);
    expect(new TextDecoder().decode(body)).toBe("%PDF");
  });
});

describe("Retry-After parsing", () => {
  const now = Date.parse("2026-07-21T00:00:00Z");

  it("accepts both delay-seconds and HTTP-date forms", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Mon, 21 Jul 2026 00:01:30 GMT", now)).toBe(90_000);
  });

  it("uses safe bounds for malformed, past, and excessive values", () => {
    expect(parseRetryAfter(null, now)).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(parseRetryAfter("not-a-date", now)).toBe(DEFAULT_RETRY_AFTER_MS);
    expect(parseRetryAfter("Sun, 20 Jul 2026 23:59:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("99999999", now)).toBe(MAX_RETRY_AFTER_MS);
  });
});
