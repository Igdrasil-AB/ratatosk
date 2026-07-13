import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSink } from "../../src/ingest/http-sink";
import type { FetchedDocument } from "../../src/core/types";

function doc(): FetchedDocument {
  return {
    source: "ext:acme",
    vendorId: "acme",
    vendorName: "Acme",
    vendorInvoiceId: "1",
    issuedAt: "2026-01-01",
    filename: "a.pdf",
    contentType: "application/pdf",
    bytes: new Uint8Array([1, 2, 3]).buffer,
    idempotencyKey: "k1",
  };
}

const okResponse = () => ({ status: 200, ok: true, json: async () => ({ document_id: "d1" }) });

afterEach(() => vi.restoreAllMocks());

describe("HttpSink security", () => {
  it("refuses a non-https endpoint (no cleartext)", async () => {
    const sink = new HttpSink({ endpoint: "http://evil.example/ingest" });
    await expect(sink.send(doc())).rejects.toThrow(/https/);
  });

  it("allows http on localhost for dev", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse() as unknown as Response);
    const sink = new HttpSink({ endpoint: "http://localhost:8080/ingest" });
    await expect(sink.send(doc())).resolves.toMatchObject({ accepted: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("refuses to send the token to a host that isn't allow-listed", async () => {
    const sink = new HttpSink({
      endpoint: "https://evil.example/ingest",
      token: async () => "SECRET-TOKEN",
      allowTokenHosts: ["api.igdrasil.se"],
    });
    await expect(sink.send(doc())).rejects.toThrow(/allow-list/);
  });

  it("sends the token only when the host IS allow-listed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse() as unknown as Response);
    const sink = new HttpSink({
      endpoint: "https://api.igdrasil.se/documents/ingest",
      token: async () => "SECRET-TOKEN",
      allowTokenHosts: ["api.igdrasil.se"],
    });
    await sink.send(doc());
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer SECRET-TOKEN");
  });
});
