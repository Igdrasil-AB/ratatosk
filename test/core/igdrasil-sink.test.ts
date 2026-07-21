import { afterEach, describe, expect, it, vi } from "vitest";
import { createIgdrasilSink } from "../../src/ingest/igdrasil-sink";
import type { FetchedDocument } from "../../src/core/types";

const document: FetchedDocument = {
  source: "ext:acme",
  vendorId: "acme",
  vendorName: "Acme",
  vendorInvoiceId: "invoice-1",
  issuedAt: "2026-07-20",
  filename: "invoice.pdf",
  contentType: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.7").buffer,
  idempotencyKey: "identity-1",
  contentIdempotencyKey: "content-1",
};

afterEach(() => vi.restoreAllMocks());

describe("Igdrasil sink", () => {
  it("rejects a collector token destination outside the Igdrasil host boundary", () => {
    expect(() => createIgdrasilSink({
      baseUrl: "https://upload.attacker.example",
      companyId: "company-1",
      getToken: async () => "rat_".padEnd(68, "a"),
    })).toThrow(/Igdrasil backend/i);
  });

  it("rejects other Igdrasil subdomains rather than deriving token trust from input", () => {
    expect(() => createIgdrasilSink({
      baseUrl: "https://api.igdrasil.se",
      companyId: "company-1",
      getToken: async () => "rat_".padEnd(68, "a"),
    })).toThrow(/Igdrasil backend/i);
  });

  it("rejects a trusted Igdrasil hostname on a non-default port", () => {
    const getToken = vi.fn(async () => "rat_".padEnd(68, "a"));

    expect(() => createIgdrasilSink({
      baseUrl: "https://accounting.igdrasil.se:8443",
      companyId: "company-1",
      getToken,
    })).toThrow(/Igdrasil backend/i);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("uses the documented canonical ingest route on an approved backend", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ document_id: "document-1" }),
    } as unknown as Response);
    const sink = createIgdrasilSink({
      baseUrl: "https://accounting.igdrasil.se/",
      companyId: "company-1",
      getToken: async () => "rat_".padEnd(68, "a"),
    });

    await sink.send(document);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://accounting.igdrasil.se/api/documents/ingest",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer rat_/),
          "X-Company-Id": "company-1",
        }),
      }),
    );
  });
});
