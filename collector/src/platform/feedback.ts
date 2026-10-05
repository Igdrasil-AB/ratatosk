import { OPERATIONAL_OUTCOME_CODES } from "../../../src/core/errors";
import { buildCollectorDiagnostic, readLastRunEvidence, type CollectorDiagnostic } from "./diagnostics";
import { parseDiscoveryDiagnostic, type DiscoveryDiagnosticV1 } from "./discovery-diagnostic";

export const FEEDBACK_ORIGIN = "https://svala.igdrasil.se/*";
export const FEEDBACK_URL = "https://svala.igdrasil.se/api/public/ratatosk/feedback";
const PENDING_KEY = "feedback.pending.v1";
const RECEIPT_KEY = "feedback.receipt.v1";
const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type FeedbackKind = "discovery" | "collection_failure" | "missing_invoices" | "wrong_document";
export type FeedbackReport = {
  schema: "ratatosk.feedback.v1";
  reportId: string;
  kind: FeedbackKind;
  diagnostic: DiscoveryDiagnosticV1 | CollectorDiagnostic;
  note?: string;
};
export type FeedbackReceipt = { reportId: string; acceptedAt: string; status: "received" };
export type FeedbackStatus = {
  pending?: { reportId: string; kind: FeedbackKind; siteOrVendor: string; note?: string };
  receipt?: FeedbackReceipt;
};
export type FeedbackSendResult =
  | { state: "received"; receipt: FeedbackReceipt }
  | { state: "retryable" | "rejected" | "permission_required"; reportId: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100_000;
}

export function normalizeFeedbackNote(value: string): string | undefined {
  const note = value.trim().replace(/\s+/g, " ");
  if (!note) return undefined;
  if (note.length > 500 || /https?:|www\.|@|\b(?:bearer|token|secret|password)\b|\d{8,}/i.test(note)) {
    throw new Error("Remove links, account numbers, and credentials from the note.");
  }
  return note;
}

function sanitizeCollector(value: unknown): CollectorDiagnostic {
  const raw = record(value);
  const counts = record(raw?.counts);
  const runtime = raw?.runtime === undefined ? null : record(raw.runtime);
  if (!raw || raw.schema !== "ratatosk.collector-diagnostic.v2" ||
    typeof raw.vendorId !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(raw.vendorId) ||
    typeof raw.collectorVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.collectorVersion) ||
    typeof raw.lifecycleRevision !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(raw.lifecycleRevision) ||
    !OPERATIONAL_OUTCOME_CODES.includes(raw.outcomeCode as never) ||
    !counts || ![counts.collected, counts.documentActions, counts.failedScopes, counts.emptyScopes].every(count) ||
    (raw.runtime !== undefined && (!runtime || !count(runtime.discoveryEngine) || runtime.discoveryEngine > 10_000 ||
      !count(runtime.documentAcquisition) || runtime.documentAcquisition > 10_000))) {
    throw new Error("Feedback diagnostic is unavailable.");
  }
  for (const key of ["recordedAt", "nextEligibleAt"] as const) {
    const value = raw[key];
    if (value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value)) throw new Error("Feedback diagnostic is unavailable.");
  }
  const lastRunEvidence = raw.lastRunEvidence === undefined ? undefined : readLastRunEvidence(raw.lastRunEvidence);
  if (raw.lastRunEvidence !== undefined && !lastRunEvidence) throw new Error("Feedback diagnostic is unavailable.");
  return buildCollectorDiagnostic({
    vendorId: raw.vendorId,
    collectorVersion: raw.collectorVersion,
    lifecycleRevision: raw.lifecycleRevision,
    ...(runtime ? { runtime: { discoveryEngine: runtime.discoveryEngine as number, documentAcquisition: runtime.documentAcquisition as number } } : {}),
    connection: {
      vendorId: raw.vendorId, connectedAt: 1,
      ...(raw.recordedAt ? { lastRunAt: Date.parse(raw.recordedAt as string) } : {}),
      ...(raw.nextEligibleAt ? { nextEligibleRunAt: Date.parse(raw.nextEligibleAt as string) } : {}),
      lastCode: raw.outcomeCode as CollectorDiagnostic["outcomeCode"],
      lastCount: counts.collected as number, lastDocumentActionCount: counts.documentActions as number,
      lastFailedScopes: counts.failedScopes as number, lastEmptyScopes: counts.emptyScopes as number,
      ...(lastRunEvidence ? { lastRunEvidence } : {}),
    },
  });
}

export function sanitizeFeedbackReport(value: unknown): FeedbackReport {
  const raw = record(value);
  if (!raw || raw.schema !== "ratatosk.feedback.v1" || typeof raw.reportId !== "string" ||
    !UUID.test(raw.reportId) ||
    (raw.kind !== "discovery" && raw.kind !== "collection_failure" && raw.kind !== "missing_invoices" && raw.kind !== "wrong_document") ||
    (raw.note !== undefined && typeof raw.note !== "string")) throw new Error("Feedback report is unavailable.");
  const diagnostic = raw.kind === "discovery"
    ? parseDiscoveryDiagnostic(raw.diagnostic)
    : sanitizeCollector(raw.diagnostic);
  const report: FeedbackReport = {
    schema: "ratatosk.feedback.v1", reportId: raw.reportId, kind: raw.kind,
    diagnostic,
    ...(raw.note ? { note: normalizeFeedbackNote(raw.note as string) } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(report)).byteLength > MAX_BODY_BYTES) {
    throw new Error("Feedback report is too large.");
  }
  return report;
}

export function createFeedbackReport(kind: FeedbackKind, diagnostic: DiscoveryDiagnosticV1 | CollectorDiagnostic, note: string): FeedbackReport {
  const cleanNote = normalizeFeedbackNote(note);
  return sanitizeFeedbackReport({ schema: "ratatosk.feedback.v1", reportId: crypto.randomUUID(), kind, diagnostic,
    ...(cleanNote ? { note: cleanNote } : {}) });
}

function summary(report: FeedbackReport): NonNullable<FeedbackStatus["pending"]> {
  return { reportId: report.reportId, kind: report.kind,
    siteOrVendor: report.diagnostic.schema === "ratatosk.discovery-diagnostic.v11"
      ? report.diagnostic.site : report.diagnostic.vendorId,
    ...(report.note ? { note: report.note } : {}) };
}

export async function pendingFeedback(): Promise<FeedbackReport | null> {
  const stored = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY];
  if (stored === undefined) return null;
  try { return sanitizeFeedbackReport(stored); }
  catch { await chrome.storage.local.remove(PENDING_KEY); return null; }
}

export function pendingFeedbackDecision(previous: FeedbackReport | null, next: FeedbackReport): "reuse" | "replace" | "blocked" {
  if (!previous) return "replace";
  if (previous.kind !== next.kind || JSON.stringify(previous.diagnostic) !== JSON.stringify(next.diagnostic)) return "blocked";
  return previous.note === next.note ? "reuse" : "replace";
}

export async function feedbackStatus(): Promise<FeedbackStatus> {
  const pending = await pendingFeedback();
  const stored = (await chrome.storage.local.get(RECEIPT_KEY))[RECEIPT_KEY];
  const raw = record(stored);
  const receipt = raw && validReceipt(raw, raw.reportId) ? raw as FeedbackReceipt : undefined;
  return { ...(pending ? { pending: summary(pending) } : {}), ...(receipt ? { receipt } : {}) };
}

export async function queueFeedback(report: FeedbackReport): Promise<void> {
  await chrome.storage.local.set({ [PENDING_KEY]: sanitizeFeedbackReport(report) });
}

export async function discardPendingFeedback(): Promise<void> {
  await chrome.storage.local.remove(PENDING_KEY);
}

function validReceipt(value: Record<string, unknown>, reportId: unknown): boolean {
  return Object.keys(value).length === 3 && typeof value.reportId === "string" && UUID.test(value.reportId) &&
    value.reportId === reportId && value.status === "received" &&
    typeof value.acceptedAt === "string" && Number.isFinite(Date.parse(value.acceptedAt)) &&
    new Date(value.acceptedAt).toISOString() === value.acceptedAt;
}

async function responseJson(response: globalThis.Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 4_096) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return null; }
}

export async function deliverPendingFeedback(http: typeof fetch = fetch): Promise<FeedbackSendResult | null> {
  const report = await pendingFeedback();
  if (!report) return null;
  const hasPermission = await chrome.permissions.contains({ origins: [FEEDBACK_ORIGIN] });
  if (!hasPermission) return { state: "permission_required", reportId: report.reportId };
  let response: globalThis.Response;
  try {
    response = await http(FEEDBACK_URL, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(12_000),
      headers: { "Content-Type": "application/json", "Idempotency-Key": report.reportId },
      body: JSON.stringify(report),
    });
  } catch { return { state: "retryable", reportId: report.reportId }; }
  if (response.status !== 200 && response.status !== 201) {
    return { state: response.status === 429 || response.status >= 500 ? "retryable" : "rejected", reportId: report.reportId };
  }
  const raw = record(await responseJson(response));
  const receipt = record(raw?.receipt);
  if (!receipt || !validReceipt(receipt, report.reportId)) return { state: "retryable", reportId: report.reportId };
  const accepted = receipt as FeedbackReceipt;
  await chrome.storage.local.set({ [RECEIPT_KEY]: accepted });
  await chrome.storage.local.remove(PENDING_KEY);
  return { state: "received", receipt: accepted };
}
