import { describe, expect, it } from "vitest";
import { buildAgentReport, redactSecrets } from "../../src/core/recorder/report";
import type { CaptureSession } from "../../src/core/recorder/types";

describe("report redaction", () => {
  it("scrubs bearer tokens and JWTs", () => {
    const dirty =
      "Authorization: Bearer sk_live_ABC123DEF456GHI789 and eyJhbGciOiJIUzI1NiJ9.payloadpayload123.signature";
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain("sk_live_ABC123DEF456GHI789");
    expect(clean).not.toMatch(/eyJhbGc/);
    expect(clean).toContain("«redacted");
  });

  it("preserves the Bearer {token} recipe template", () => {
    expect(redactSecrets('"authorization": "Bearer {token}"')).toContain("Bearer {token}");
  });

  it("never emits a captured secret in the built report", () => {
    const session: CaptureSession = {
      origin: "https://acme.example",
      entries: [
        {
          url: "https://acme.example/billing",
          method: "GET",
          status: 200,
          contentType: "text/html",
          responseBody:
            "<html><body>Bearer sk_live_TOPSECRET1234567890 eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuv.sig</body></html>",
        },
      ],
    } as unknown as CaptureSession;
    const report = buildAgentReport({ version: "test", session, draft: null, docLinks: [] });
    expect(report).not.toContain("sk_live_TOPSECRET1234567890");
    expect(report).not.toMatch(/eyJhbGc/);
  });
});
