import type { FetchedDocument } from "../../../src/core/types";
import type { IngestResult, IngestSink } from "../../../src/ingest/sink";

/**
 * Saves each invoice to disk as `Downloads/<root>/<supplier>/<date>/<file>`,
 * via `chrome.downloads` (which creates the subfolders from the path).
 *
 * Why downloads and not the File System Access API: this runs in the background
 * service worker (for scheduled syncs), where `showDirectoryPicker` isn't
 * available. Service workers also can't create Blob URLs, so bytes go out as a
 * `data:` URL — fine for invoice-sized files.
 *
 * Duplicates: the engine's persisted seen-store skips already-saved invoices
 * before download, so each is saved once. With `dateMode: "invoice"` the path is
 * a pure function of the invoice, so a re-save overwrites rather than
 * duplicating even if that store is ever lost.
 */
export interface FilesystemSinkOptions {
  rootFolder: string;
  dateMode: "extraction" | "invoice";
}

export class FilesystemSink implements IngestSink {
  constructor(private readonly opts: FilesystemSinkOptions) {}

  async send(doc: FetchedDocument): Promise<IngestResult> {
    const path = buildInvoicePath(
      { rootFolder: this.opts.rootFolder, dateMode: this.opts.dateMode, extractionDate: todayISO() },
      doc,
    );
    const url = `data:${doc.contentType || "application/pdf"};base64,${toBase64(doc.bytes)}`;
    await download(url, path, this.opts.dateMode === "invoice" ? "overwrite" : "uniquify");
    return { accepted: true };
  }
}

// ---- pure, unit-tested ----------------------------------------------------

/** Build the relative save path. Pure so the folder scheme is testable without Chrome. */
export function buildInvoicePath(
  cfg: { rootFolder: string; dateMode: "extraction" | "invoice"; extractionDate: string },
  doc: { vendorName?: string; vendorId: string; issuedAt: string; filename: string },
): string {
  const dateFolder = cfg.dateMode === "invoice" ? doc.issuedAt || "undated" : cfg.extractionDate;
  return [
    segment(cfg.rootFolder || "InvoiceCollector"),
    segment(doc.vendorName || doc.vendorId),
    segment(dateFolder),
    fileName(doc.filename),
  ].join("/");
}

/** Drop control characters (code point < 0x20) without a fragile control-char regex. */
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    if ((ch.codePointAt(0) ?? 0) >= 0x20) out += ch;
  }
  return out;
}

/** Sanitize a single path segment (folder name). */
function segment(s: string): string {
  const cleaned = stripControl(s.replace(/[/\\:*?"<>|]/g, "-"))
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "unknown";
}

/** Sanitize a filename (keeps the extension dot). */
function fileName(s: string): string {
  const cleaned = stripControl(s.replace(/[/\\:*?"<>|]/g, "-")).trim();
  return cleaned || "invoice.pdf";
}

// ---- Chrome bits ----------------------------------------------------------

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

function download(
  url: string,
  filename: string,
  conflictAction: "uniquify" | "overwrite",
): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction, saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        reject(new Error(chrome.runtime.lastError?.message ?? "download failed"));
      } else {
        resolve();
      }
    });
  });
}
