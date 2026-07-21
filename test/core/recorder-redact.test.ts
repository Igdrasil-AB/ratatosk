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
    expect(out.invoice_pdf_url).toContain("REDACTED_VALUE_1"); // long capability token scrubbed
    expect(out.invoice_pdf_url).not.toContain("YWNjdF8xTUV4UTlCaklR");
    expect(out.contact).toContain("user@example.com"); // inline email scrubbed
  });

  it("recurses through arrays and nested objects", () => {
    const out = redact({ rows: [{ email: "a@b.com" }, { email: "c@d.com" }] }) as any;
    expect(out.rows[0].email).toBe("REDACTED");
    expect(out.rows[1].email).toBe("REDACTED");
  });

  it("keeps distinct long identifiers distinct while preserving equality", () => {
    const first = "invoice_0123456789abcdefghijklmnop";
    const second = "invoice_zyxwvutsrqponmlkjihg987654";
    const out = redact({
      invoices: [
        { id: first, duplicateOf: first },
        { id: second },
      ],
    }) as any;

    expect(out.invoices[0].id).toBe("REDACTED_VALUE_1");
    expect(out.invoices[0].duplicateOf).toBe(out.invoices[0].id);
    expect(out.invoices[1].id).toBe("REDACTED_VALUE_2");
    expect(out.invoices[1].id).not.toBe(out.invoices[0].id);
    expect(JSON.stringify(out)).not.toMatch(new RegExp(`${first}|${second}`));
  });

  it("keeps a sensitive parent key while traversing arrays", () => {
    expect(redact({ customer_names: ["Jane Doe", "John Doe"] })).toEqual({
      customer_names: ["REDACTED", "REDACTED"],
    });
  });

  it("redacts short valid credential fields that token-pattern matching cannot detect", () => {
    expect(redact({
      customerName: "Jane Doe",
      emailAddress: "jane@example.com",
      credential: "short-credential-42",
      passcode: "1234",
      privateKey: "private-value",
    })).toEqual({
      customerName: "REDACTED",
      emailAddress: "REDACTED",
      credential: "REDACTED",
      passcode: "REDACTED",
      privateKey: "REDACTED",
    });
  });

  it("replaces personal and capability-shaped property names", () => {
    const paymentCapability = ["sk", "live", "synthetic", "capability", "value"].join("_");
    const result = redact({
      "owner@example.com": "owner@example.com",
      [paymentCapability]: "secret",
      invoices: [{ id: "inv_1" }],
    }) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain("owner@example.com");
    expect(JSON.stringify(result)).not.toContain(paymentCapability);
    expect(result.invoices).toEqual([{ id: "inv_1" }]);
  });

  it("redacts payment fields and standalone valid payment values", () => {
    const cardNumber = "4111 1111 1111 1111";
    const iban = "GB82 WEST 1234 5698 7654 32";
    const result = redact({
      cardNumber,
      cvv: "123",
      iban,
      bankAccount: "123456789",
      routingNumber: "021000021",
      note: cardNumber,
      memo: iban,
    });

    expect(result).toEqual({
      cardNumber: "REDACTED",
      cvv: "REDACTED",
      iban: "REDACTED",
      bankAccount: "REDACTED",
      routingNumber: "REDACTED",
      note: "REDACTED",
      memo: "REDACTED",
    });
  });
});
