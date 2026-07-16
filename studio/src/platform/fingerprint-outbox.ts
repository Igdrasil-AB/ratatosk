import {
  parseSupplierFingerprintSubmission,
  type SupplierFingerprintSubmissionV1,
} from "../../../src/core/recorder/supplier-fingerprint";
import {
  svalaFingerprintTransport,
  type SvalaFingerprintDeliveryResult,
  type SvalaFingerprintReceipt,
} from "./fingerprint-transport";
import type {
  FingerprintDeliveryState,
  FingerprintOutboxItemSummary,
  FingerprintOutboxStatus,
} from "./messaging";

const STORAGE_KEY = "studio:supplier-fingerprint-outbox:v1";
const MAX_ITEMS = 20;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1_000;
const FAILURE_REASONS = ["network", "rate_limited", "server", "rejected"] as const;
type FailureReason = typeof FAILURE_REASONS[number];

interface StoredItem {
  queuedAt: string;
  expiresAt: string;
  submission: SupplierFingerprintSubmissionV1;
  deliveryState: FingerprintDeliveryState;
  attempts: number;
  nextAttemptAt?: string;
  receipt?: SvalaFingerprintReceipt;
  missionCode?: string;
  mission?: { missionId: string; status: string };
  lastFailure?: FailureReason;
}

let writeChain = Promise.resolve();
const inFlight = new Map<string, Promise<FingerprintOutboxItemSummary | undefined>>();

export function enqueueFingerprintSubmission(submission: unknown, now = new Date(), missionCode?: string): Promise<FingerprintOutboxStatus> {
  return serialized(async () => {
    const valid = parseSupplierFingerprintSubmission(submission);
    const items = await readValidItems(now, false);
    const withoutDuplicate = items.filter((item) => item.submission.fingerprint.fingerprintId !== valid.fingerprint.fingerprintId);
    withoutDuplicate.push({
      queuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
      submission: valid,
      deliveryState: "pending",
      attempts: 0,
      ...(missionCode && /^rmc_[A-Za-z0-9_-]{43}$/.test(missionCode) ? { missionCode } : {}),
    });
    const retained = withoutDuplicate.slice(-MAX_ITEMS);
    await persist(retained);
    return statusFrom(retained);
  });
}

export function fingerprintOutboxStatus(now = new Date()): Promise<FingerprintOutboxStatus> {
  return serialized(async () => statusFrom(await readValidItems(now, true)));
}

export function listFingerprintOutboxItems(now = new Date()): Promise<readonly FingerprintOutboxItemSummary[]> {
  return serialized(async () => (await readValidItems(now, true)).map(summaryFrom));
}

export function getFingerprintOutboxSubmission(
  fingerprintId: string,
  now = new Date(),
): Promise<SupplierFingerprintSubmissionV1 | undefined> {
  return serialized(async () => {
    if (!/^fp_[a-f0-9]{32}$/.test(fingerprintId)) return undefined;
    const item = (await readValidItems(now, true)).find(
      (candidate) => candidate.submission.fingerprint.fingerprintId === fingerprintId,
    );
    return item ? parseSupplierFingerprintSubmission(item.submission) : undefined;
  });
}

export function deliverFingerprintSubmission(
  fingerprintId: string,
  now = new Date(),
): Promise<FingerprintOutboxItemSummary | undefined> {
  if (!/^fp_[a-f0-9]{32}$/.test(fingerprintId)) return Promise.resolve(undefined);
  const existing = inFlight.get(fingerprintId);
  if (existing) return existing;
  const task = serialized(async () => {
    const items = await readValidItems(now, false);
    const index = items.findIndex((item) => item.submission.fingerprint.fingerprintId === fingerprintId);
    if (index < 0) return undefined;
    const current = items[index] as StoredItem;
    if (current.deliveryState === "delivered" || current.deliveryState === "rejected") return summaryFrom(current);
    if (current.deliveryState === "retryable" && current.nextAttemptAt && Date.parse(current.nextAttemptAt) > now.getTime()) {
      return summaryFrom(current);
    }
    if (!(await svalaFingerprintTransport.configured())) return summaryFrom(current);

    const delivering: StoredItem = {
      ...current,
      deliveryState: "delivering",
      attempts: current.attempts + 1,
      nextAttemptAt: undefined,
      lastFailure: undefined,
    };
    items[index] = delivering;
    await persist(items);
    const result = await svalaFingerprintTransport.deliver(delivering.submission, { missionCode: delivering.missionCode });
    const updated = resultItem(delivering, result, now);
    items[index] = updated;
    await persist(items);
    return summaryFrom(updated);
  });
  inFlight.set(fingerprintId, task);
  void task.then(() => inFlight.delete(fingerprintId), () => inFlight.delete(fingerprintId));
  return task;
}

export async function resumeFingerprintDeliveries(now = new Date()): Promise<void> {
  const items = await listFingerprintOutboxItems(now);
  for (const item of items) {
    if (item.deliveryState === "pending" || (item.deliveryState === "retryable" && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now.getTime()))) {
      await deliverFingerprintSubmission(item.fingerprintId, now);
    }
  }
}

export function requeueRejectedFingerprintSubmissions(now = new Date()): Promise<FingerprintOutboxStatus> {
  return serialized(async () => {
    const items = await readValidItems(now, true);
    const updated = items.map((item): StoredItem => item.deliveryState === "rejected"
      ? { ...item, deliveryState: "pending", nextAttemptAt: undefined, lastFailure: undefined }
      : item);
    await persist(updated);
    return statusFrom(updated);
  });
}

export function clearFingerprintOutbox(): Promise<FingerprintOutboxStatus> {
  return serialized(async () => {
    await chrome.storage.local.remove(STORAGE_KEY);
    return statusFrom([]);
  });
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeChain.then(operation, operation);
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}

async function readValidItems(now: Date, recoverInterrupted: boolean): Promise<StoredItem[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY];
  if (!Array.isArray(raw)) return [];
  let changed = false;
  const valid = raw.flatMap((value) => {
    const parsed = parseStoredItem(value, now);
    if (!parsed) { changed = true; return []; }
    if (recoverInterrupted && parsed.deliveryState === "delivering") {
      changed = true;
      return [{ ...parsed, deliveryState: "retryable" as const, nextAttemptAt: now.toISOString(), lastFailure: "network" as const }];
    }
    return [parsed];
  }).slice(-MAX_ITEMS);
  if (valid.length !== raw.length) changed = true;
  if (changed) await persist(valid);
  return valid;
}

function parseStoredItem(value: unknown, now: Date): StoredItem | undefined {
  if (!isRecordWithOnly(value, ["queuedAt", "expiresAt", "submission", "deliveryState", "attempts", "nextAttemptAt", "receipt", "lastFailure", "missionCode", "mission"])) return undefined;
  if (typeof value.queuedAt !== "string" || typeof value.expiresAt !== "string") return undefined;
  const queuedAt = Date.parse(value.queuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(queuedAt) || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return undefined;
  let submission: SupplierFingerprintSubmissionV1;
  try { submission = parseSupplierFingerprintSubmission(value.submission); }
  catch { return undefined; }

  // Records created by Studio 0.7.0 before delivery was configured migrate to pending.
  if (value.deliveryState === undefined && value.attempts === undefined) {
    return { queuedAt: value.queuedAt, expiresAt: value.expiresAt, submission, deliveryState: "pending", attempts: 0 };
  }
  if (!isDeliveryState(value.deliveryState) || !Number.isInteger(value.attempts) || Number(value.attempts) < 0 || Number(value.attempts) > 10_000) return undefined;
  const item: StoredItem = {
    queuedAt: value.queuedAt,
    expiresAt: value.expiresAt,
    submission,
    deliveryState: value.deliveryState,
    attempts: Number(value.attempts),
  };
  if (value.nextAttemptAt !== undefined) {
    if (typeof value.nextAttemptAt !== "string" || !Number.isFinite(Date.parse(value.nextAttemptAt))) return undefined;
    item.nextAttemptAt = value.nextAttemptAt;
  }
  if (value.lastFailure !== undefined) {
    if (!FAILURE_REASONS.includes(value.lastFailure as FailureReason)) return undefined;
    item.lastFailure = value.lastFailure as FailureReason;
  }
  if (value.receipt !== undefined) {
    const receipt = parseStoredReceipt(value.receipt, submission.fingerprint.fingerprintId);
    if (!receipt) return undefined;
    item.receipt = receipt;
  }
  if (value.missionCode !== undefined) {
    if (typeof value.missionCode !== "string" || !/^rmc_[A-Za-z0-9_-]{43}$/.test(value.missionCode)) return undefined;
    item.missionCode = value.missionCode;
  }
  if (value.mission !== undefined) {
    if (!isExactRecord(value.mission, ["missionId", "status"]) || typeof value.mission.missionId !== "string" || !/^ratmission_[a-f0-9]{32}$/.test(value.mission.missionId) || typeof value.mission.status !== "string") return undefined;
    item.mission = { missionId: value.mission.missionId, status: value.mission.status };
  }
  if (item.deliveryState === "delivered" && !item.receipt) return undefined;
  return item;
}

async function statusFrom(items: StoredItem[]): Promise<FingerprintOutboxStatus> {
  return {
    totalCount: items.length,
    pendingCount: items.filter((item) => ["pending", "delivering", "retryable"].includes(item.deliveryState)).length,
    deliveredCount: items.filter((item) => item.deliveryState === "delivered").length,
    rejectedCount: items.filter((item) => item.deliveryState === "rejected").length,
    ...(items[0] ? { oldestQueuedAt: items[0].queuedAt } : {}),
    transport: { target: svalaFingerprintTransport.target, configured: await svalaFingerprintTransport.configured() },
  };
}

function summaryFrom(item: StoredItem): FingerprintOutboxItemSummary {
  return Object.freeze({
    fingerprintId: item.submission.fingerprint.fingerprintId,
    supplierId: item.submission.fingerprint.supplier.idCandidate,
    supplierOrigin: item.submission.fingerprint.supplier.origin,
    capturedAt: item.submission.fingerprint.capturedAt,
    queuedAt: item.queuedAt,
    expiresAt: item.expiresAt,
    deliveryState: item.deliveryState,
    attempts: item.attempts,
    ...(item.nextAttemptAt ? { nextAttemptAt: item.nextAttemptAt } : {}),
    ...(item.receipt ? { receipt: { receiptId: item.receipt.receiptId, acceptedAt: item.receipt.acceptedAt, status: item.receipt.status } } : {}),
    ...(item.mission ? { mission: item.mission } : {}),
  });
}

function resultItem(current: StoredItem, result: SvalaFingerprintDeliveryResult, now: Date): StoredItem {
  if (result.delivered) return { ...current, deliveryState: "delivered", receipt: result.receipt, ...(result.mission ? { mission: result.mission } : {}), missionCode: undefined, nextAttemptAt: undefined, lastFailure: undefined };
  if (result.reason === "not_configured") return { ...current, deliveryState: "pending", nextAttemptAt: undefined, lastFailure: undefined };
  if (result.reason === "rejected") return { ...current, deliveryState: "rejected", nextAttemptAt: undefined, lastFailure: "rejected" };
  const exponential = Math.min(60_000 * (2 ** Math.min(Math.max(current.attempts - 1, 0), 10)), MAX_RETRY_MS);
  const delay = result.reason === "rate_limited" && result.retryAfterMs
    ? Math.min(Math.max(result.retryAfterMs, exponential), MAX_RETRY_MS)
    : exponential;
  return {
    ...current,
    deliveryState: "retryable",
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
    lastFailure: result.reason,
  };
}

function parseStoredReceipt(value: unknown, fingerprintId: string): SvalaFingerprintReceipt | undefined {
  if (!isExactRecord(value, ["receiptId", "fingerprintId", "acceptedAt", "status"])) return undefined;
  if (typeof value.receiptId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.receiptId)) return undefined;
  if (value.fingerprintId !== fingerprintId || typeof value.acceptedAt !== "string" || !Number.isFinite(Date.parse(value.acceptedAt)) || value.status !== "accepted") return undefined;
  return value as unknown as SvalaFingerprintReceipt;
}

function isDeliveryState(value: unknown): value is FingerprintDeliveryState {
  return ["pending", "delivering", "delivered", "retryable", "rejected"].includes(String(value));
}

function isRecordWithOnly(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key))
    && ["queuedAt", "expiresAt", "submission"].every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

async function persist(items: StoredItem[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}
