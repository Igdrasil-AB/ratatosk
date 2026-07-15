import { describe, expect, it } from "vitest";
import { buildEntry, sanitizeBody, sanitizeHeaders, sanitizeUrl } from "../../src/core/recorder/cdp";

/**
 * Capture-layer guarantees: authentication material never reaches session
 * storage. Non-sensitive structure remains available for recipe inference.
 */
describe("request-header capture", () => {
  it("drops auth headers and lower-cases safe keys", () => {
    const clean = sanitizeHeaders({ Authorization: "Bearer abc", "Content-Type": "application/json", Cookie: "session=secret" });
    expect(clean).toEqual({ "content-type": "application/json" });
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
    expect(entry.requestHeaders).toBeUndefined();
  });

  it("redacts URL values and secret-bearing JSON fields", () => {
    expect(sanitizeUrl("https://api.example/invoices?account=123&sig=secret#row")).toBe(
      "https://api.example/invoices?account=REDACTED&sig=REDACTED",
    );
    const body = sanitizeBody('{"invoice":{"id":"inv_1"},"accessToken":"secret-value"}', "application/json");
    expect(JSON.parse(body)).toEqual({ invoice: { id: "inv_1" }, accessToken: "REDACTED" });
  });

  it("redacts high-entropy path capabilities and UUIDs", () => {
    const clean = sanitizeUrl(
      "https://files.example/invoice/in_1234567890abcdefghijklmnop/550e8400-e29b-41d4-a716-446655440000/pdf",
    );
    expect(clean).toBe("https://files.example/invoice/REDACTED/REDACTED/pdf");
    expect(clean).not.toContain("in_1234567890");
    expect(clean).not.toContain("550e8400");
  });
});
