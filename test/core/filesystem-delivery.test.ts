import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFilesystemDeliveryJournalForSource,
  FilesystemSink,
  waitForCompletedDownload,
} from "../../collector/src/platform/filesystem-sink";

describe("filesystem delivery completion", () => {
  let listener: ((delta: chrome.downloads.DownloadDelta) => void) | undefined;

  beforeEach(() => {
    listener = undefined;
    vi.stubGlobal("chrome", {
      runtime: {},
      downloads: {
        onChanged: {
          addListener: vi.fn((next: typeof listener) => { listener = next; }),
          removeListener: vi.fn((current: typeof listener) => {
            if (listener === current) listener = undefined;
          }),
        },
        search: vi.fn((_query: unknown, callback: (items: Array<{ state: string }>) => void) => {
          callback([{ state: "in_progress" }]);
        }),
      },
    });
  });

  it("waits for Chrome to confirm the terminal complete state", async () => {
    const delivery = waitForCompletedDownload(42);
    let settled = false;
    void delivery.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    listener?.({ id: 42, state: { current: "complete" } } as chrome.downloads.DownloadDelta);
    await expect(delivery).resolves.toBeUndefined();
    expect(listener).toBeUndefined();
  });

  it("rejects interrupted downloads so they remain retryable", async () => {
    const delivery = waitForCompletedDownload(43);
    listener?.({ id: 43, state: { current: "interrupted" } } as chrome.downloads.DownloadDelta);
    await expect(delivery).rejects.toThrow("interrupted");
    expect(listener).toBeUndefined();
  });

  it("reuses one overwrite path when journal commit fails after a completed download", async () => {
    const identity = "a".repeat(64);
    const stored: Record<string, unknown> = {};
    let setCalls = 0;
    const downloads: chrome.downloads.DownloadOptions[] = [];
    vi.stubGlobal("chrome", {
      runtime: {},
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            setCalls++;
            if (setCalls === 2) throw new Error("journal commit unavailable");
            Object.assign(stored, items);
          }),
        },
      },
      downloads: {
        download: vi.fn((options: chrome.downloads.DownloadOptions, callback: (id: number) => void) => {
          downloads.push(options);
          callback(downloads.length);
        }),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        search: vi.fn((_query: unknown, callback: (items: Array<{ state: string }>) => void) => {
          callback([{ state: "complete" }]);
        }),
      },
    });
    const sink = new FilesystemSink({ rootFolder: "Invoices", dateMode: "extraction" });
    const document = {
      source: "ext:vendor",
      vendorId: "vendor",
      vendorName: "Vendor",
      vendorInvoiceId: "invoice-1",
      issuedAt: "2026-07-01",
      filename: "invoice.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]).buffer,
      idempotencyKey: identity,
      contentIdempotencyKey: "b".repeat(64),
    };

    await expect(sink.send(document)).rejects.toThrow("journal commit unavailable");
    await expect(sink.send(document)).resolves.toEqual({ accepted: true });
    await expect(sink.send(document)).resolves.toEqual({ accepted: true, deduped: true });

    expect(downloads).toHaveLength(2);
    expect(new Set(downloads.map(({ filename }) => filename)).size).toBe(1);
    expect(downloads.every(({ conflictAction }) => conflictAction === "overwrite")).toBe(true);
    expect(downloads[0].filename).toContain(identity);
  });

  it("downloads again after the supplier's filesystem history is forgotten", async () => {
    const stored: Record<string, unknown> = {};
    const downloads: chrome.downloads.DownloadOptions[] = [];
    vi.stubGlobal("chrome", {
      runtime: {},
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(stored, items); }),
        },
      },
      downloads: {
        download: vi.fn((options: chrome.downloads.DownloadOptions, callback: (id: number) => void) => {
          downloads.push(options);
          callback(downloads.length);
        }),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        search: vi.fn((_query: unknown, callback: (items: Array<{ state: string }>) => void) => {
          callback([{ state: "complete" }]);
        }),
      },
    });
    const sink = new FilesystemSink({ rootFolder: "Invoices", dateMode: "extraction" });
    const document = {
      source: "ext:vendor",
      vendorId: "vendor",
      vendorName: "Vendor",
      vendorInvoiceId: "invoice-1",
      issuedAt: "2026-07-01",
      filename: "invoice.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]).buffer,
      idempotencyKey: "c".repeat(64),
      contentIdempotencyKey: "d".repeat(64),
    };

    await expect(sink.send(document)).resolves.toEqual({ accepted: true });
    await expect(sink.send(document)).resolves.toEqual({ accepted: true, deduped: true });
    await clearFilesystemDeliveryJournalForSource(document.source);
    await expect(sink.send(document)).resolves.toEqual({ accepted: true });

    expect(downloads).toHaveLength(2);
  });
});
