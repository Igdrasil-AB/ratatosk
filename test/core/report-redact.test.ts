import { describe, expect, it } from "vitest";
import { buildAgentReport, redactSecrets } from "../../src/core/recorder/report";
import type { CaptureSession } from "../../src/core/recorder/types";

describe("report redaction", () => {
  it("scrubs bearer tokens and JWTs", () => {
    const fakeApiKey = ["sk", "live", "EXAMPLE", "REDACT", "ME"].join("_");
    const fakeJwt = ["eyJhbGciOiJIUzI1NiJ9", "payloadpayload123", "signature"].join(".");
    const dirty = `Authorization: Bearer ${fakeApiKey} and ${fakeJwt}`;
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain(fakeApiKey);
    expect(clean).not.toMatch(/eyJhbGc/);
    expect(clean).toContain("«redacted");
  });

  it("preserves the Bearer {token} recipe template", () => {
    expect(redactSecrets('"authorization": "Bearer {token}"')).toContain("Bearer {token}");
  });

  it("never emits a captured secret in the built report", () => {
    const fakeApiKey = ["sk", "live", "EXAMPLE", "REPORT", "SECRET"].join("_");
    const fakeJwt = ["eyJhbGciOiJIUzI1NiJ9", "abcdefghijklmnopqrstuv", "sig"].join(".");
    const session: CaptureSession = {
      origin: "https://acme.example",
      entries: [
        {
          url: "https://acme.example/billing",
          method: "GET",
          status: 200,
          contentType: "text/html",
          responseBody: `<html><body>Bearer ${fakeApiKey} ${fakeJwt}</body></html>`,
        },
      ],
    } as unknown as CaptureSession;
    const report = buildAgentReport({ version: "test", session, draft: null, docLinks: [] });
    expect(report).not.toContain(fakeApiKey);
    expect(report).not.toMatch(/eyJhbGc/);
  });

  it("removes query values, API keys, and email addresses", () => {
    const dirty = "https://example.test/invoice?signature=abc123&account=42 api_live_1234567890123456 owner@example.test";
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain("abc123");
    expect(clean).not.toContain("api_live_");
    expect(clean).not.toContain("owner@example.test");
  });
});
