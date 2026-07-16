import { describe, expect, it } from "vitest";
import { inferRecipe } from "../../src/core/recorder/infer";
import {
  approveSupplierFingerprint,
  buildSupplierFingerprint,
  parseSupplierFingerprint,
} from "../../src/core/recorder/supplier-fingerprint";
import type { CaptureSession } from "../../src/core/recorder/types";

const ACCOUNT = "11111111-2222-4333-8444-555555555555";
const TOKEN = `eyJhbGciOiJ${"A".repeat(60)}`;

function capturedSession(): CaptureSession {
  return {
    origin: "https://billing.example.com",
    entries: [
      {
        url: "https://billing.example.com/api/organizations",
        method: "GET",
        status: 200,
        contentType: "application/json",
        responseBody: JSON.stringify({
          user: { email: "owner@example.com", accessToken: TOKEN },
          organization: { id: ACCOUNT },
        }),
      },
      {
        url: `https://billing.example.com/api/organizations/${ACCOUNT}/invoices?limit=100&page=secret-cursor`,
        method: "POST",
        status: 200,
        contentType: "application/json",
        requestHeaders: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        requestBody: JSON.stringify({ operationName: "BillingInvoices", variables: { organizationId: ACCOUNT } }),
        responseBody: JSON.stringify({
          invoices: [{ id: "invoice-secret-123", amount: 9000, currency: "sek", issuedAt: "2026-07-01", pdfUrl: `https://files.example.com/invoices/${ACCOUNT}/invoice-secret-123.pdf` }],
          next_cursor: "secret-next-page",
        }),
      },
      {
        url: `https://files.example.com/invoices/${ACCOUNT}/invoice-secret-123.pdf?signature=secret`,
        method: "GET",
        status: 200,
        contentType: "application/pdf",
      },
    ],
  };
}

describe("shareable supplier fingerprint", () => {
  it("keeps structural evidence while excluding captured values and raw payloads", () => {
    const session = capturedSession();
    const fingerprint = buildSupplierFingerprint({
      fingerprintId: "fp_0123456789abcdef0123456789abcdef",
      capturedAt: "2026-07-16T10:00:00.000Z",
      studioVersion: "0.7.0",
      session,
      draft: inferRecipe(session),
    });

    expect(parseSupplierFingerprint(fingerprint)).toEqual(fingerprint);
    expect(fingerprint.schema).toBe("ratatosk.supplier-fingerprint.v1");
    expect(fingerprint.supplier).toEqual({ origin: "https://billing.example.com", idCandidate: "billing-example" });
    expect(fingerprint.evidence.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: "https://billing.example.com", pathPattern: "/api/organizations/{id}/invoices", queryKeys: ["limit", "page"] }),
      expect.objectContaining({ origin: "https://files.example.com", pathPattern: "/invoices/{id}/{id}", role: "document" }),
    ]));
    expect(fingerprint.evidence.inferred?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "id", path: "id" }),
      expect.objectContaining({ field: "total", path: "amount" }),
      expect.objectContaining({ field: "documentUrl", path: "pdfUrl" }),
    ]));

    const serialized = JSON.stringify(fingerprint);
    for (const forbidden of [ACCOUNT, TOKEN, "owner@example.com", "invoice-secret-123", "secret-cursor", "secret-next-page", "9000", "2026-07-01"]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const forbiddenKey of ['"requestBody":', '"responseBody":', '"requestHeaders":', '"fixture":', '"recipe":']) {
      expect(serialized).not.toContain(forbiddenKey);
    }
    expect(fingerprint.privacy).toEqual({
      structuralOnly: true,
      rawBodiesIncluded: false,
      requestHeadersIncluded: false,
      fixtureIncluded: false,
      queryValuesIncluded: false,
      invoiceValuesIncluded: false,
    });
  });

  it("requires affirmative authority and share approval before creating a Svala outbox item", () => {
    const session = capturedSession();
    const fingerprint = buildSupplierFingerprint({
      fingerprintId: "fp_0123456789abcdef0123456789abcdef",
      capturedAt: "2026-07-16T10:00:00.000Z",
      studioVersion: "0.7.0",
      session,
      draft: inferRecipe(session),
    });

    expect(() => approveSupplierFingerprint({ fingerprint, approvedAt: "2026-07-16T10:01:00.000Z", authorityConfirmed: false, shareApproved: true })).toThrow(/authority/i);
    expect(() => approveSupplierFingerprint({ fingerprint, approvedAt: "2026-07-16T10:01:00.000Z", authorityConfirmed: true, shareApproved: false })).toThrow(/approve/i);

    expect(approveSupplierFingerprint({
      fingerprint,
      approvedAt: "2026-07-16T10:01:00.000Z",
      authorityConfirmed: true,
      shareApproved: true,
    })).toEqual(expect.objectContaining({
      schema: "ratatosk.supplier-fingerprint-submission.v1",
      target: "svala",
      fingerprint,
      consent: expect.objectContaining({ statementVersion: "ratatosk.studio.share.v1", authorityConfirmed: true, shareApproved: true }),
    }));
  });

  it("rejects unknown fields and shareable strings that look like leaked values", () => {
    const session = capturedSession();
    const fingerprint = buildSupplierFingerprint({
      fingerprintId: "fp_0123456789abcdef0123456789abcdef",
      capturedAt: "2026-07-16T10:00:00.000Z",
      studioVersion: "0.7.0",
      session,
      draft: inferRecipe(session),
    });

    expect(() => parseSupplierFingerprint({ ...fingerprint, rawCapture: "secret" })).toThrow();
    expect(() => parseSupplierFingerprint({
      ...fingerprint,
      supplier: { ...fingerprint.supplier, idCandidate: "owner@example.com" },
    })).toThrow();
  });
});
