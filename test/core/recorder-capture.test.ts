import { describe, expect, it } from "vitest";
import { buildEntry, detectRequestAuth, sanitizeBody, sanitizeHeaders, sanitizeUrl } from "../../src/core/recorder/cdp";

/**
 * Capture-layer guarantees: authentication material never reaches session
 * storage. Non-sensitive structure remains available for recipe inference.
 */
describe("request-header capture", () => {
  it("allowlists only normalized content-type values", () => {
    const clean = sanitizeHeaders({
      Authorization: "Bearer abc",
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      "X-Custom-Auth": "random-high-entropy-credential-0123456789",
      Cookie: "session=secret",
    });
    expect(clean).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(clean)).not.toMatch(/secret|high-entropy|credential/i);
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
    expect(entry.requestAuth).toEqual({ scheme: "bearer", headerName: "authorization" });
    expect(JSON.stringify(entry)).not.toContain("Bearer t");
  });

  it.each([
    [{ Authorization: "Bearer synthetic-secret" }, { scheme: "bearer", headerName: "authorization" }],
    [{ AUTHORIZATION: "Basic synthetic-secret" }, { scheme: "basic", headerName: "authorization" }],
    [{ "X-Supplier-Session": "synthetic-secret" }, { scheme: "custom", headerName: "x-supplier-session" }],
    [{ Cookie: "sid=synthetic-secret" }, { scheme: "custom", headerName: "cookie" }],
    [{ Accept: "application/json" }, { scheme: "none" }],
    [{ ["x".repeat(100)]: "synthetic-secret" }, { scheme: "none" }],
  ])("keeps only bounded authentication structure for %o", (headers, expected) => {
    expect(detectRequestAuth(headers)).toEqual(expected);
    const serialized = JSON.stringify(buildEntry({
      url: "https://api.example/invoices",
      method: "GET",
      status: 200,
      contentType: "application/json",
      requestHeaders: headers,
    }));
    expect(serialized).not.toContain("synthetic-secret");
  });

  it("redacts URL values and secret-bearing JSON fields", () => {
    expect(sanitizeUrl("https://api.example/invoices?account=123&sig=secret#row")).toBe(
      "https://api.example/invoices?account=REDACTED&sig=REDACTED",
    );
    const body = sanitizeBody('{"invoice":{"id":"inv_1"},"accessToken":"secret-value"}', "application/json");
    expect(JSON.parse(body)).toEqual({ invoice: { id: "inv_1" }, accessToken: "REDACTED" });
    const entry = buildEntry({
      url: "https://api.example/session",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: '{"nested":{"accessToken":"secret-value"},"not_tokenized":"also-redacted"}',
    });
    expect(entry.redactedResponsePaths).toEqual(["nested.accessToken", "not_tokenized"]);
    expect(JSON.stringify(entry)).not.toContain("secret-value");
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
