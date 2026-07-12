import { describe, expect, it } from "vitest";
import { buildEntry, sanitizeHeaders } from "../../src/core/recorder/cdp";

/**
 * Capture-layer guarantees: request headers are kept for inference (so token/key
 * auth can wire itself), but the session cookie is never hoarded, and header keys
 * are normalized to lower case so lookups (`authorization`) are reliable.
 */
describe("request-header capture", () => {
  it("keeps auth headers, lower-cases keys, and drops the cookie", () => {
    const clean = sanitizeHeaders({ Authorization: "Bearer abc", "Content-Type": "application/json", Cookie: "session=secret" });
    expect(clean).toEqual({ authorization: "Bearer abc", "content-type": "application/json" });
    expect(JSON.stringify(clean)).not.toContain("secret");
  });

  it("returns undefined when nothing survives sanitizing", () => {
    expect(sanitizeHeaders({ cookie: "x" })).toBeUndefined();
    expect(sanitizeHeaders(undefined)).toBeUndefined();
  });

  it("buildEntry attaches sanitized request headers", () => {
    const entry = buildEntry({
      url: "https://api.example/invoices",
      method: "get",
      status: 200,
      contentType: "application/json",
      body: "{}",
      requestHeaders: { Authorization: "Bearer t", Cookie: "c=1" },
    });
    expect(entry.requestHeaders).toEqual({ authorization: "Bearer t" });
  });
});
