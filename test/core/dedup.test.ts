import { describe, expect, it } from "vitest";
import { contentIdempotencyKey } from "../../src/core/dedup";

const COMPANY = "local";
const SOURCE = "ext:discovered-chatgpt";

describe("content idempotency", () => {
  it("recognizes a regenerated Stripe invoice despite volatile PDF container fields", async () => {
    const first = stripeInvoicePdf({
      createdAt: "D:20260726083839+00'00'",
      paymentToken: "live_first",
      documentId: "F733F54F42D528F4CA5A63FB7B47F2BB",
      invoiceNumber: "Z70VMX4J-0001",
    });
    const second = stripeInvoicePdf({
      createdAt: "D:20260726091842+00'00'",
      paymentToken: "live_second",
      documentId: "5F6B210D84AF4374C04F6ACDDB7C779B",
      invoiceNumber: "Z70VMX4J-0001",
    });

    await expect(contentIdempotencyKey(COMPANY, SOURCE, first)).resolves.toBe(
      await contentIdempotencyKey(COMPANY, SOURCE, second),
    );
  });

  it("keeps distinct invoices separate after canonicalizing volatile fields", async () => {
    const first = stripeInvoicePdf({
      createdAt: "D:20260726083839+00'00'",
      paymentToken: "live_first",
      documentId: "F733F54F42D528F4CA5A63FB7B47F2BB",
      invoiceNumber: "Z70VMX4J-0001",
    });
    const second = stripeInvoicePdf({
      createdAt: "D:20260726091842+00'00'",
      paymentToken: "live_second",
      documentId: "5F6B210D84AF4374C04F6ACDDB7C779B",
      invoiceNumber: "Z70VMX4J-0002",
    });

    await expect(contentIdempotencyKey(COMPANY, SOURCE, first)).resolves.not.toBe(
      await contentIdempotencyKey(COMPANY, SOURCE, second),
    );
  });

  it("does not ignore arbitrary links or PDF stream contents", async () => {
    const linkedFirst = genericPdf("/URI (https://vendor.example/invoices/one)");
    const linkedSecond = genericPdf("/URI (https://vendor.example/invoices/two)");
    const streamedFirst = genericPdf("stream\n/CreationDate (D:20260726083839+00'00')\nendstream");
    const streamedSecond = genericPdf("stream\n/CreationDate (D:20260726091842+00'00')\nendstream");

    await expect(contentIdempotencyKey(COMPANY, SOURCE, linkedFirst)).resolves.not.toBe(
      await contentIdempotencyKey(COMPANY, SOURCE, linkedSecond),
    );
    await expect(contentIdempotencyKey(COMPANY, SOURCE, streamedFirst)).resolves.not.toBe(
      await contentIdempotencyKey(COMPANY, SOURCE, streamedSecond),
    );
  });
});

function stripeInvoicePdf(input: {
  createdAt: string;
  paymentToken: string;
  documentId: string;
  invoiceNumber: string;
}): ArrayBuffer {
  return genericPdf([
    `/CreationDate (${input.createdAt})`,
    `/ModDate (${input.createdAt})`,
    `/URI (https://invoice.stripe.com/i/acct_test/${input.paymentToken}?s=pd)`,
    `stream\nInvoice number ${input.invoiceNumber}\nendstream`,
    `/ID [<${input.documentId}> <${input.documentId}>]`,
  ].join("\n"));
}

function genericPdf(body: string): ArrayBuffer {
  return new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF`).buffer;
}
