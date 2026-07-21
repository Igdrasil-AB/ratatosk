import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inferRecipe } from "../../src/core/recorder/infer";
import { buildEntry, createCaptureRedactionContext } from "../../src/core/recorder/cdp";
import {
  approveSupplierFingerprint,
  buildSupplierFingerprint,
  parseSupplierFingerprint,
} from "../../src/core/recorder/supplier-fingerprint";
import type { CaptureSession } from "../../src/core/recorder/types";

const ACCOUNT = "11111111-2222-4333-8444-555555555555";
const TOKEN = `eyJhbGciOiJ${"A".repeat(60)}`;
const contractFixture = JSON.parse(readFileSync(
  new URL("../fixtures/ratatosk/valid-submission.json", import.meta.url),
  "utf8",
));

function capturedSession(): CaptureSession {
  const redactionContext = createCaptureRedactionContext();
  return {
    origin: "https://billing.example.com",
    entries: [
      buildEntry({
        url: "https://billing.example.com/api/organizations",
        method: "GET",
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { email: "owner@example.com", accessToken: TOKEN },
          organization: { id: ACCOUNT },
        }),
        redactionContext,
      }),
      buildEntry({
        url: `https://billing.example.com/api/organizations/${ACCOUNT}/invoices?limit=100&page=1`,
        method: "POST",
        status: 200,
        contentType: "application/json",
        requestHeaders: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        requestBody: JSON.stringify({
          operationName: "BillingInvoices",
          query: "query BillingInvoices($organizationId: ID!) { invoices { id amount currency issuedAt pdfUrl } }",
          variables: { organizationId: ACCOUNT },
        }),
        body: JSON.stringify({
          invoices: [{ id: "invoice-secret-123", amount: 9000, currency: "sek", issuedAt: "2026-07-01", pdfUrl: `https://files.example.com/invoices/${ACCOUNT}/invoice-secret-123.pdf` }],
          next_cursor: "secret-next-page",
        }),
        redactionContext,
      }),
      buildEntry({
        url: `https://files.example.com/invoices/${ACCOUNT}/invoice-secret-123.pdf?signature=secret`,
        method: "GET",
        status: 200,
        contentType: "application/pdf",
        redactionContext,
      }),
    ],
  };
}

describe("shareable supplier fingerprint", () => {
  it("accepts the exact cross-repository Svala contract fixture", () => {
    const fingerprint = parseSupplierFingerprint(contractFixture.fingerprint);
    expect(approveSupplierFingerprint({
      fingerprint,
      approvedAt: contractFixture.consent.approvedAt,
      authorityConfirmed: contractFixture.consent.authorityConfirmed,
      shareApproved: contractFixture.consent.shareApproved,
    })).toEqual(contractFixture);
  });

  it("keeps structural evidence while excluding captured values and raw payloads", () => {
    const session = capturedSession();
    const draft = inferRecipe(session);
    expect(draft).not.toBeNull();
    expect(JSON.stringify(draft!.recipe)).not.toContain("REDACTED");
    const fingerprint = buildSupplierFingerprint({
      fingerprintId: "fp_0123456789abcdef0123456789abcdef",
      capturedAt: "2026-07-16T10:00:00.000Z",
      studioVersion: "0.7.0",
      session,
      draft,
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
    for (const forbidden of [ACCOUNT, TOKEN, "owner@example.com", "invoice-secret-123", "secret-next-page", "9000", "2026-07-01"]) {
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

  it("keeps inferred invoice and document requests when noisy apps exceed the request cap", () => {
    const entries = Array.from({ length: 45 }, (_, index) => buildEntry({
      url: `https://api.example.com/telemetry/event-${index}`,
      method: "GET",
      status: 200 + index,
      contentType: "application/json",
      body: '{"ok":true}',
    }));
    entries.push(buildEntry({
      url: "https://api.example.com/billing/invoices",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ invoices: [{ id: "invoice-1", date: "2026-07-01", amount: 1000 }] }),
    }));
    entries.push(buildEntry({
      url: "https://api.example.com/billing/invoices/invoice-1/pdf",
      method: "GET",
      status: 200,
      contentType: "application/pdf",
    }));

    const session: CaptureSession = { origin: "https://app.example.com", entries };
    const fingerprint = buildSupplierFingerprint({
      fingerprintId: "fp_0123456789abcdef0123456789abcdef",
      capturedAt: "2026-07-16T10:00:00.000Z",
      studioVersion: "0.7.0",
      session,
      draft: inferRecipe(session),
    });

    expect(fingerprint.evidence.requests).toHaveLength(40);
    expect(fingerprint.evidence.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "invoice_list", pathPattern: "/billing/invoices" }),
      expect.objectContaining({ role: "document", pathPattern: "/billing/invoices/{id}/pdf" }),
    ]));
  });

  it("does not let unrelated GraphQL operations evict the inferred invoice request", () => {
    const entries = Array.from({ length: 45 }, (_, index) => buildEntry({
      url: "https://api.example.com/graphql",
      method: "POST",
      status: 200,
      contentType: "application/json",
      requestHeaders: { "content-type": "application/json" },
      requestBody: JSON.stringify({
        operationName: `UnrelatedOperation${index}`,
        query: `query UnrelatedOperation${index} { viewer { id } }`,
      }),
      body: '{"viewer":{"id":"user_1"}}',
    }));
    entries.push(buildEntry({
      url: "https://api.example.com/graphql",
      method: "POST",
      status: 200,
      contentType: "application/json",
      requestHeaders: { "content-type": "application/json" },
      requestBody: JSON.stringify({
        operationName: "BillingInvoices",
        query: "query BillingInvoices { invoices { id date amount } }",
      }),
      body: '{"invoices":[{"id":"invoice-1","date":"2026-07-01","amount":1000}]}',
    }));
    entries.push(buildEntry({
      url: "https://api.example.com/invoices/invoice-1/pdf",
      method: "GET",
      status: 200,
      contentType: "application/pdf",
    }));

    const session: CaptureSession = { origin: "https://app.example.com", entries };
    const draft = inferRecipe(session);
    expect(draft).not.toBeNull();
    const fingerprint = buildSupplierFingerprint({
      fingerprintId: "fp_0123456789abcdef0123456789abcdef",
      capturedAt: "2026-07-16T10:00:00.000Z",
      studioVersion: "0.7.0",
      session,
      draft,
    });

    expect(fingerprint.evidence.requests).toHaveLength(40);
    expect(fingerprint.evidence.requests.filter((request) => request.role === "invoice_list")).toEqual([
      expect.objectContaining({ method: "POST", pathPattern: "/graphql", operationName: "BillingInvoices" }),
    ]);
    expect(fingerprint.evidence.requests).toContainEqual(
      expect.objectContaining({ role: "document", pathPattern: "/invoices/{id}/pdf" }),
    );
  });

  it("resolves relative captured request URLs against the session origin", () => {
    const session: CaptureSession = {
      origin: "https://billing.example.com",
      entries: [buildEntry({
        url: "/api/invoices?limit=100",
        method: "GET",
        status: 200,
        contentType: "application/json",
        body: '{"items":[]}',
      })],
    };

    const fingerprint = buildSupplierFingerprint({
      fingerprintId: "fp_0123456789abcdef0123456789abcdef",
      capturedAt: "2026-07-16T10:00:00.000Z",
      studioVersion: "0.7.0",
      session,
      draft: null,
    });

    expect(fingerprint.evidence.requests).toContainEqual(expect.objectContaining({
      origin: "https://billing.example.com",
      pathPattern: "/api/invoices",
      queryKeys: ["limit"],
    }));
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
    expect(() => parseSupplierFingerprint({
      ...fingerprint,
      supplier: { ...fingerprint.supplier, origin: "https://user:password@billing.example.com/private" },
    })).toThrow(/origin/i);
    expect(() => parseSupplierFingerprint({
      ...fingerprint,
      evidence: {
        ...fingerprint.evidence,
        requests: [{ ...fingerprint.evidence.requests[0], pathPattern: "/api/../private" }],
      },
    })).toThrow(/traversal/i);
    expect(() => parseSupplierFingerprint({
      ...fingerprint,
      supplier: { ...fingerprint.supplier, idCandidate: "a".repeat(70_000) },
    })).toThrow(/safety limit/i);
  });
});
