import { describe, expect, it, vi } from "vitest";
import { DocumentPermissionRequired, UnexpectedResponse } from "../../src/core/errors";
import { createSemanticDocumentFetch } from "../../collector/src/platform/semantic-document-fetch";

describe("semantic action document fetch", () => {
  it("turns an ungranted redirect into an exact-origin permission continuation", async () => {
    const redirect = new TestRedirectEvent();
    const base = vi.fn(async () => {
      redirect.emit({
        requestId: "request-1",
        url: "https://assets.vendor.example/invoice.pdf?signature=secret",
        redirectUrl: "https://storage.example/document.pdf?signature=other-secret",
      });
      throw new TypeError("Failed to fetch");
    });
    const fetch = createSemanticDocumentFetch(
      base,
      new Set(["https://assets.vendor.example"]),
      "vendor",
      {
        redirectEvent: redirect,
        hasOrigins: async (origins) => !origins.includes("https://storage.example/*"),
      },
    );

    let error: unknown;
    try {
      await fetch({ url: "https://assets.vendor.example/invoice.pdf?signature=secret" }, {});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DocumentPermissionRequired);
    expect((error as DocumentPermissionRequired).requiredOrigins).toEqual([
      "https://storage.example/*",
    ]);
    expect(JSON.stringify(error)).not.toContain("signature");
    expect(redirect.listenerCount).toBe(0);
  });

  it("classifies an opaque transport rejection instead of returning unknown", async () => {
    const fetch = createSemanticDocumentFetch(
      async () => { throw new TypeError("Failed to fetch"); },
      new Set(["https://assets.vendor.example"]),
      "vendor",
      {
        redirectEvent: new TestRedirectEvent(),
        hasOrigins: async () => true,
      },
    );

    await expect(fetch({ url: "https://assets.vendor.example/invoice.pdf" }, {}))
      .rejects.toBeInstanceOf(UnexpectedResponse);
  });

  it("returns a successful response when every redirect origin is already granted", async () => {
    const redirect = new TestRedirectEvent();
    const response = {
      ok: true,
      status: 200,
      url: "https://storage.example/document.pdf",
      arrayBuffer: async () => new ArrayBuffer(1),
      json: async () => ({}),
      headers: { get: () => "application/pdf" },
    };
    const fetch = createSemanticDocumentFetch(
      async () => {
        redirect.emit({
          requestId: "request-1",
          url: "https://assets.vendor.example/invoice.pdf",
          redirectUrl: response.url,
        });
        return response;
      },
      new Set(["https://assets.vendor.example", "https://storage.example"]),
      "vendor",
      {
        redirectEvent: redirect,
        hasOrigins: async () => true,
      },
    );

    await expect(fetch({ url: "https://assets.vendor.example/invoice.pdf" }, {}))
      .resolves.toBe(response);
    expect(redirect.listenerCount).toBe(0);
  });
});

class TestRedirectEvent {
  private readonly listeners = new Set<(details: {
    requestId: string;
    url: string;
    redirectUrl: string;
  }) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  addListener(listener: (details: {
    requestId: string;
    url: string;
    redirectUrl: string;
  }) => void): void {
    this.listeners.add(listener);
  }

  removeListener(listener: (details: {
    requestId: string;
    url: string;
    redirectUrl: string;
  }) => void): void {
    this.listeners.delete(listener);
  }

  emit(details: { requestId: string; url: string; redirectUrl: string }): void {
    for (const listener of this.listeners) listener(details);
  }
}
