import { describe, expect, it } from "vitest";
import {
  documentCandidateFromObservation,
  SemanticActionObserver,
  type SemanticActionObserverPlatform,
} from "../../collector/src/platform/semantic-action-observer";

describe("semantic action observer boundary", () => {
  const allowed = new Set(["https://vendor.example", "https://documents.example"]);

  it("accepts bounded GET document responses from recipe-approved origins", () => {
    expect(documentCandidateFromObservation({
      url: "https://documents.example/capability/opaque-value",
      method: "GET",
      contentType: "application/pdf",
    }, allowed)).toBe("https://documents.example/capability/opaque-value");

    expect(documentCandidateFromObservation({
      url: "https://vendor.example/invoices/123/download",
      method: "GET",
    }, allowed)).toBe("https://vendor.example/invoices/123/download");
  });

  it("never promotes POST requests, foreign origins, credentials, or unrelated resources", () => {
    expect(documentCandidateFromObservation({
      url: "https://documents.example/capability/opaque-value",
      method: "POST",
      contentType: "application/pdf",
    }, allowed)).toBeUndefined();
    expect(documentCandidateFromObservation({
      url: "https://attacker.example/invoice.pdf",
      method: "GET",
      contentType: "application/pdf",
    }, allowed)).toBeUndefined();
    expect(documentCandidateFromObservation({
      url: "https://user:secret@documents.example/invoice.pdf",
      method: "GET",
      contentType: "application/pdf",
    }, allowed)).toBeUndefined();
    expect(documentCandidateFromObservation({
      url: "https://vendor.example/assets/application.js",
      method: "GET",
      contentType: "application/javascript",
    }, allowed)).toBeUndefined();
  });

  it("uses final download metadata without requiring document-shaped signed URLs", () => {
    expect(documentCandidateFromObservation({
      url: "https://documents.example/signed/opaque-value",
      method: "GET",
      contentType: "application/octet-stream",
      filename: "/Downloads/invoice-2026-07.pdf",
    }, allowed)).toBe("https://documents.example/signed/opaque-value");
  });

  it("correlates only the active tab and removes every listener at the end of the run", () => {
    const beforeRequest = new FakeEvent<Record<string, unknown>>();
    const headersReceived = new FakeEvent<Record<string, unknown>>();
    const beforeRedirect = new FakeEvent<Record<string, unknown>>();
    const downloadCreated = new FakeEvent<Record<string, unknown>>();
    const platform = {
      beforeRequest,
      headersReceived,
      beforeRedirect,
      downloadCreated,
    } as unknown as SemanticActionObserverPlatform;
    const observer = new SemanticActionObserver(allowed, platform);

    expect(observer.start(7)).toBe(true);
    observer.beginAction();
    beforeRequest.emit({ requestId: "wrong-tab", tabId: 8, url: "https://vendor.example/invoices/wrong/download", method: "GET" });
    beforeRequest.emit({ requestId: "request-1", tabId: 7, url: "https://vendor.example/invoices/123/download", method: "GET" });
    headersReceived.emit({
      requestId: "request-1",
      tabId: 7,
      url: "https://vendor.example/invoices/123/download",
      method: "GET",
      responseHeaders: [
        { name: "Content-Type", value: "application/pdf" },
        { name: "Content-Disposition", value: 'attachment; filename="receipt-42.pdf"' },
      ],
    });
    beforeRedirect.emit({
      requestId: "request-1",
      tabId: 7,
      url: "https://vendor.example/invoices/123/download",
      redirectUrl: "https://documents.example/signed/redirected",
      method: "GET",
    });
    downloadCreated.emit({
      id: 1,
      url: "https://documents.example/unrelated/same-origin",
      finalUrl: "https://documents.example/unrelated/same-origin",
      mime: "application/pdf",
      filename: "/Downloads/unrelated.pdf",
    });
    beforeRequest.emit({
      requestId: "request-2",
      tabId: 7,
      url: "https://documents.example/signed/opaque-item",
      method: "GET",
    });
    // A request on the exact action tab is not enough ownership proof by
    // itself. The unrelated download with that URL remains untouched until a
    // document response for the same request chain has been observed.
    downloadCreated.emit({
      id: 2,
      url: "https://documents.example/signed/opaque-item",
      finalUrl: "https://documents.example/signed/opaque-item",
      mime: "application/octet-stream",
      filename: "/Downloads/unrelated.pdf",
    });
    headersReceived.emit({
      requestId: "request-2",
      tabId: 7,
      url: "https://documents.example/signed/opaque-item",
      method: "GET",
      responseHeaders: [
        { name: "Content-Type", value: "application/octet-stream" },
        { name: "Content-Disposition", value: 'attachment; filename="invoice.pdf"' },
      ],
    });
    downloadCreated.emit({
      id: 3,
      url: "https://documents.example/signed/opaque-item",
      finalUrl: "https://documents.example/signed/opaque-item",
      mime: "application/octet-stream",
      filename: "/Downloads/invoice.pdf",
    });

    expect(observer.snapshotDocuments()).toEqual([
      "https://vendor.example/invoices/123/download",
      "https://documents.example/signed/redirected",
      "https://documents.example/signed/opaque-item",
    ]);
    expect(observer.snapshotDocumentObservations()).toEqual([
      {
        url: "https://vendor.example/invoices/123/download",
        evidence: [{
          source: "content-disposition",
          confidence: "medium",
          filename: "receipt-42.pdf",
        }],
      },
      {
        url: "https://documents.example/signed/opaque-item",
        evidence: [{
          source: "download-filename",
          confidence: "medium",
          filename: "invoice.pdf",
        }],
      },
    ]);
    expect(observer.snapshotDownloadIds()).toEqual([3]);

    observer.endAction();
    observer.stop();
    expect(beforeRequest.listenerCount).toBe(0);
    expect(headersReceived.listenerCount).toBe(0);
    expect(beforeRedirect.listenerCount).toBe(0);
    expect(downloadCreated.listenerCount).toBe(0);
  });
});

class FakeEvent<T> {
  private readonly listeners = new Set<(details: T) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  addListener(listener: (details: T) => void): void {
    this.listeners.add(listener);
  }

  removeListener(listener: (details: T) => void): void {
    this.listeners.delete(listener);
  }

  emit(details: T): void {
    for (const listener of this.listeners) listener(details);
  }
}
