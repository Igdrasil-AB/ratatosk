import type { FetchedDocument } from "../../../src/core/types";
import type { IngestResult, IngestSink } from "../../../src/ingest/sink";
import { folderSegments, pathSegment, rememberDownloadRoot, stripControl } from "./download-path";

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
 * before download. Invoice-mode paths include the stable delivery identity, so
 * a retry can safely overwrite only its own file and never a same-date invoice
 * that happened to use the same supplier filename.
 */
export interface FilesystemSinkOptions {
  rootFolder: string;
  dateMode: "extraction" | "invoice";
}
const DELIVERY_IDENTITY = /^[a-f0-9]{64}$/i;
const DELIVERY_SOURCE = /^ext:[a-z0-9][a-z0-9-]{0,79}$/;
const DELIVERY_JOURNAL_KEY = "filesystemDeliveryJournalV1";
const MAX_DELIVERY_JOURNAL_ENTRIES = 500;

interface FilesystemDeliveryEntry {
  source?: string;
  destination: string;
  path: string;
  status: "pending" | "committed";
  updatedAt: number;
}

let journalMutation: Promise<void> = Promise.resolve();

export class FilesystemSink implements IngestSink {
  constructor(private readonly opts: FilesystemSinkOptions) {}

  async send(doc: FetchedDocument): Promise<IngestResult> {
    if (!isDeliveryIdentity(doc.idempotencyKey)) throw new Error("filesystem delivery requires a stable document identity");
    const proposedPath = buildInvoicePath(
      { rootFolder: this.opts.rootFolder, dateMode: this.opts.dateMode, extractionDate: todayISO() },
      doc,
    );
    const destination = `${this.opts.rootFolder}\n${this.opts.dateMode}`;
    if (!DELIVERY_SOURCE.test(doc.source)) throw new Error("filesystem delivery requires a valid supplier source");
    const delivery = await prepareFilesystemDelivery(doc.idempotencyKey, doc.source, destination, proposedPath);
    if (delivery.status === "committed") return { accepted: true, deduped: true };

    const url = `data:${doc.contentType || "application/pdf"};base64,${toBase64(doc.bytes)}`;
    await download(url, delivery.path, "overwrite");
    await commitFilesystemDelivery(doc.idempotencyKey, destination, delivery.path);
    return { accepted: true };
  }
}

// ---- pure, unit-tested ----------------------------------------------------

/** Build the relative save path. Pure so the folder scheme is testable without Chrome. */
export function buildInvoicePath(
  cfg: { rootFolder: string; dateMode: "extraction" | "invoice"; extractionDate: string },
  doc: { vendorName?: string; vendorId: string; issuedAt?: string; filename: string; idempotencyKey?: string },
): string {
  const dateFolder = cfg.dateMode === "invoice" ? doc.issuedAt || "undated" : cfg.extractionDate;
  const filename = isDeliveryIdentity(doc.idempotencyKey)
    ? fileNameWithIdentity(doc.filename, doc.idempotencyKey)
    : fileName(doc.filename);
  // The one place a path must exist even when the configuration named nothing.
  const root = folderSegments(cfg.rootFolder);
  return [
    ...(root.length ? root : ["InvoiceCollector"]),
    pathSegment(doc.vendorName || doc.vendorId) || "unknown",
    pathSegment(dateFolder) || "unknown",
    filename,
  ].join("/");
}

/** Sanitize a filename (keeps the extension dot). */
function fileName(s: string): string {
  const cleaned = stripControl(s.replace(/[/\\:*?"<>|]/g, "-")).trim();
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : "invoice.pdf";
}

function fileNameWithIdentity(filename: string, identity: string): string {
  const safeFilename = fileName(filename);
  const dot = safeFilename.lastIndexOf(".");
  if (dot <= 0) return `${safeFilename}--${identity}`;
  return `${safeFilename.slice(0, dot)}--${identity}${safeFilename.slice(dot)}`;
}

function isDeliveryIdentity(value: string | undefined): value is string {
  return typeof value === "string" && DELIVERY_IDENTITY.test(value);
}

async function prepareFilesystemDelivery(
  identity: string,
  source: string,
  destination: string,
  proposedPath: string,
): Promise<FilesystemDeliveryEntry> {
  let prepared!: FilesystemDeliveryEntry;
  await mutateDeliveryJournal((journal) => {
    const existing = journal[identity];
    if (existing?.destination === destination) {
      if (existing.source && existing.source !== source) {
        throw new Error("filesystem delivery identity belongs to another supplier");
      }
      prepared = { ...existing, source };
      journal[identity] = prepared;
      return;
    }
    const entries = Object.entries(journal);
    if (entries.length >= MAX_DELIVERY_JOURNAL_ENTRIES) {
      const oldestCommitted = entries
        .filter(([, entry]) => entry.status === "committed")
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
      if (!oldestCommitted) throw new Error("filesystem delivery journal is full");
      delete journal[oldestCommitted[0]];
    }
    prepared = { source, destination, path: proposedPath, status: "pending", updatedAt: Date.now() };
    journal[identity] = prepared;
  });
  return prepared;
}

/** Remove durable filesystem dedup evidence for one explicit history reset.
 * Legacy entries have no source attribution, so they must also be removed to
 * ensure an older journal cannot silently recreate forgotten history. */
export function clearFilesystemDeliveryJournalForSource(source: string): Promise<void> {
  if (!DELIVERY_SOURCE.test(source)) return Promise.reject(new Error("invalid supplier source"));
  return mutateDeliveryJournal((journal) => {
    for (const [identity, entry] of Object.entries(journal)) {
      if (entry.source === source || entry.source === undefined) delete journal[identity];
    }
  });
}

function commitFilesystemDelivery(identity: string, destination: string, path: string): Promise<void> {
  return mutateDeliveryJournal((journal) => {
    const existing = journal[identity];
    if (!existing || existing.destination !== destination || existing.path !== path) {
      throw new Error("filesystem delivery journal changed during commit");
    }
    journal[identity] = { ...existing, status: "committed", updatedAt: Date.now() };
  });
}

function mutateDeliveryJournal(mutation: (journal: Record<string, FilesystemDeliveryEntry>) => void): Promise<void> {
  const task = journalMutation.then(async () => {
    const stored = await chrome.storage.local.get(DELIVERY_JOURNAL_KEY);
    const journal = parseDeliveryJournal(stored[DELIVERY_JOURNAL_KEY]);
    mutation(journal);
    await chrome.storage.local.set({ [DELIVERY_JOURNAL_KEY]: journal });
  });
  journalMutation = task.catch(() => undefined);
  return task;
}

function parseDeliveryJournal(value: unknown): Record<string, FilesystemDeliveryEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const journal: Record<string, FilesystemDeliveryEntry> = {};
  for (const [identity, candidate] of Object.entries(value)) {
    if (!DELIVERY_IDENTITY.test(identity) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Partial<FilesystemDeliveryEntry>;
    if (
      typeof entry.destination === "string" && typeof entry.path === "string" &&
      (entry.source === undefined || (typeof entry.source === "string" && DELIVERY_SOURCE.test(entry.source))) &&
      (entry.status === "pending" || entry.status === "committed") &&
      typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ) {
      journal[identity] = entry as FilesystemDeliveryEntry;
    }
  }
  return journal;
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
  return new Promise<number>((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction, saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        reject(new Error(chrome.runtime.lastError?.message ?? "download failed"));
      } else {
        resolve(id);
      }
    });
  }).then(async (id) => {
    await waitForCompletedDownload(id);
    await recordDownloadRoot(id, filename);
  });
}

/**
 * Look up where a completed download actually landed and hand it to
 * `download-path` to learn the root.
 *
 * Knowing the absolute path is a presentation nicety; a save that already
 * succeeded must never be reported as failed because this lookup did.
 */
async function recordDownloadRoot(downloadId: number, relativePath: string): Promise<void> {
  try {
    const absolute = await new Promise<string | undefined>((resolve) => {
      chrome.downloads.search({ id: downloadId }, (items) => {
        resolve(chrome.runtime.lastError ? undefined : items[0]?.filename);
      });
    });
    if (absolute) await rememberDownloadRoot(absolute, relativePath);
  } catch {
    // Deliberately silent, per the note above.
  }
}

const DOWNLOAD_COMPLETION_TIMEOUT_MS = 5 * 60 * 1_000;

/** Chrome accepting a download request is not a delivery commit. Resolve only
 * after the downloads subsystem reports a terminal complete state; interrupted
 * or timed-out transfers remain unseen and will be retried on the next sync. */
export function waitForCompletedDownload(
  downloadId: number,
  timeoutMs = DOWNLOAD_COMPLETION_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const inspectState = (state: string | undefined) => {
      if (state === "complete") finish();
      else if (state === "interrupted") finish(new Error("download was interrupted"));
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === downloadId) inspectState(delta.state?.current);
    };
    const timer = setTimeout(
      () => finish(new Error("download completion timed out")),
      Math.max(1_000, timeoutMs),
    );

    chrome.downloads.onChanged.addListener(onChanged);
    // Cover the race where a small data URL completed between the create
    // callback and listener registration.
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError) {
        finish(new Error(chrome.runtime.lastError.message ?? "download status unavailable"));
        return;
      }
      if (items.length === 0) {
        finish(new Error("download status unavailable"));
        return;
      }
      inspectState(items[0].state);
    });
  });
}
