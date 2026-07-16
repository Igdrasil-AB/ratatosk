import {
  parseSupplierFingerprintSubmission,
  type SupplierFingerprintSubmissionV1,
} from "../../../src/core/recorder/supplier-fingerprint";
import { svalaFingerprintTransport } from "./fingerprint-transport";
import type { FingerprintOutboxStatus } from "./messaging";

const STORAGE_KEY = "studio:supplier-fingerprint-outbox:v1";
const MAX_ITEMS = 20;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface StoredItem {
  queuedAt: string;
  expiresAt: string;
  submission: SupplierFingerprintSubmissionV1;
}

let writeChain = Promise.resolve();

export function enqueueFingerprintSubmission(submission: unknown, now = new Date()): Promise<FingerprintOutboxStatus> {
  const operation = async () => {
    const valid = parseSupplierFingerprintSubmission(submission);
    const items = await readValidItems(now);
    const withoutDuplicate = items.filter((item) => item.submission.fingerprint.fingerprintId !== valid.fingerprint.fingerprintId);
    withoutDuplicate.push({
      queuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
      submission: valid,
    });
    await chrome.storage.local.set({ [STORAGE_KEY]: withoutDuplicate.slice(-MAX_ITEMS) });
    return statusFrom(withoutDuplicate.slice(-MAX_ITEMS));
  };
  const result = writeChain.then(operation, operation);
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}

export function fingerprintOutboxStatus(now = new Date()): Promise<FingerprintOutboxStatus> {
  const operation = async () => statusFrom(await readValidItems(now));
  const result = writeChain.then(operation, operation);
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}

export function clearFingerprintOutbox(): Promise<FingerprintOutboxStatus> {
  const operation = async () => {
    await chrome.storage.local.remove(STORAGE_KEY);
    return statusFrom([]);
  };
  const result = writeChain.then(operation, operation);
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}

async function readValidItems(now: Date): Promise<StoredItem[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY];
  if (!Array.isArray(raw)) return [];
  const valid = raw.flatMap((value) => {
    if (!isExactRecord(value, ["queuedAt", "expiresAt", "submission"])) return [];
    if (typeof value.queuedAt !== "string" || typeof value.expiresAt !== "string") return [];
    const queuedAt = Date.parse(value.queuedAt);
    const expiresAt = Date.parse(value.expiresAt);
    if (!Number.isFinite(queuedAt) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return [];
    try {
      return [{ queuedAt: value.queuedAt, expiresAt: value.expiresAt, submission: parseSupplierFingerprintSubmission(value.submission) }];
    } catch {
      return [];
    }
  }).slice(-MAX_ITEMS);
  if (valid.length !== raw.length) await chrome.storage.local.set({ [STORAGE_KEY]: valid });
  return valid;
}

function statusFrom(items: StoredItem[]): FingerprintOutboxStatus {
  return {
    pendingCount: items.length,
    ...(items[0] ? { oldestQueuedAt: items[0].queuedAt } : {}),
    transport: { target: svalaFingerprintTransport.target, configured: false },
  };
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
