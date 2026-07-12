import { describe, expect, it } from "vitest";
import { redact } from "../../src/core/recorder/redact";

describe("redact", () => {
  it("scrubs emails, PII-named fields, and long tokens but keeps numbers/dates", () => {
    const out = redact({
      name: "Jane Doe",
      recipient_email: "jane@acme.com",
      total: 9000,
      created_ts: 1782543567,
      currency: "eur",
      invoice_pdf_url: "https://pay.stripe.com/invoice/acct_X/live_YWNjdF8xTUV4UTlCaklR/pdf?s=ap",
      contact: "reach me at bob@x.io please",
    }) as Record<string, unknown>;

    expect(out.name).toBe("REDACTED"); // PII key
    expect(out.recipient_email).toBe("REDACTED"); // PII key
    expect(out.total).toBe(9000); // number preserved
    expect(out.created_ts).toBe(1782543567);
    expect(out.currency).toBe("eur");
    expect(out.invoice_pdf_url).toContain("TOKEN"); // long capability token scrubbed
    expect(out.invoice_pdf_url).not.toContain("YWNjdF8xTUV4UTlCaklR");
    expect(out.contact).toContain("user@example.com"); // inline email scrubbed
  });

  it("recurses through arrays and nested objects", () => {
    const out = redact({ rows: [{ email: "a@b.com" }, { email: "c@d.com" }] }) as any;
    expect(out.rows[0].email).toBe("REDACTED");
    expect(out.rows[1].email).toBe("REDACTED");
  });
});
