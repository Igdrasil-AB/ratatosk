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
    contentIdempotencyKey: "content-k1",
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

  it("requires an explicit token allow-list before sending a bearer token", async () => {
    const sink = new HttpSink({
      endpoint: "https://api.igdrasil.se/documents/ingest",
      token: async () => "SECRET-TOKEN",
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

  it("omits issued_at when listing could not resolve the invoice date", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse() as unknown as Response);
    const sink = new HttpSink({ endpoint: "https://api.igdrasil.se/documents/ingest" });

    await sink.send({ ...doc(), issuedAt: undefined });

    const body = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;
    expect(body.has("issued_at")).toBe(false);
  });

  it("keeps the validated endpoint when the caller mutates config during token acquisition", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse() as unknown as Response);
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => { releaseToken = resolve; });
    const config = {
      endpoint: "https://api.igdrasil.se/documents/ingest",
      token: async () => token,
      allowTokenHosts: ["api.igdrasil.se"],
    };
    const sink = new HttpSink(config);

    const delivery = sink.send(doc());
    config.endpoint = "https://attacker.example/collect";
    releaseToken("SECRET-TOKEN");
    await delivery;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.igdrasil.se/documents/ingest",
      expect.anything(),
    );
  });

  it.each(["Idempotency-Key", "idempotency-key", "Authorization", "aUtHoRiZaTiOn", "Content-Type"])("rejects static reserved header %s", (header) => {
    expect(() => new HttpSink({
      endpoint: "https://api.igdrasil.se/documents/ingest",
      headers: { [header]: "replayed-value" },
    })).toThrow(/managed by HttpSink/);
  });

  it("refuses redirect-following delivery requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse() as unknown as Response);
    const sink = new HttpSink({ endpoint: "https://api.igdrasil.se/documents/ingest" });

    await sink.send(doc());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.igdrasil.se/documents/ingest",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("accepts a conflict only when the ingest contract explicitly marks it as a duplicate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 409,
      ok: false,
      json: async () => ({ duplicate: true }),
    } as Response);
    const sink = new HttpSink({ endpoint: "https://api.igdrasil.se/documents/ingest" });

    await expect(sink.send(doc())).resolves.toEqual({ accepted: true, deduped: true });
  });

  it("does not turn an unrelated conflict into a successful delivery", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      status: 409,
      ok: false,
      json: async () => ({ code: "company_inactive" }),
    } as Response);
    const sink = new HttpSink({ endpoint: "https://api.igdrasil.se/documents/ingest" });

    await expect(sink.send(doc())).rejects.toThrow("HTTP 409");
  });
});
