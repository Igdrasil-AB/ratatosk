import {
  parseSupplierFingerprintSubmission,
  type SupplierFingerprintSubmissionV1,
} from "../../../src/core/recorder/supplier-fingerprint";

export const SVALA_FINGERPRINT_ENDPOINT = "https://svala.igdrasil.se/api/dev/ratatosk/fingerprints";
const TOKEN_STORAGE_KEY = "studio:svala-fingerprint-intake-token:v1";
const TOKEN = /^rtk_[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 4 * 1024;

export interface SvalaFingerprintReceipt {
  readonly receiptId: string;
  readonly fingerprintId: string;
  readonly acceptedAt: string;
  readonly status: "accepted";
}

export type SvalaFingerprintDeliveryResult =
  | { delivered: true; receipt: SvalaFingerprintReceipt; replayed: boolean }
  | { delivered: false; reason: "not_configured" | "network" | "rate_limited" | "server" | "rejected"; retryAfterMs?: number };

export interface SupplierFingerprintTransport {
  readonly target: "svala";
  configured(): Promise<boolean>;
  deliver(submission: SupplierFingerprintSubmissionV1): Promise<SvalaFingerprintDeliveryResult>;
}

export async function pairSvalaFingerprintTransport(token: string): Promise<void> {
  const bounded = String(token || "").trim();
  if (!TOKEN.test(bounded)) throw new Error("Svala intake token is invalid");
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: bounded });
}

export async function disconnectSvalaFingerprintTransport(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
}

async function configuredToken(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  const value = stored[TOKEN_STORAGE_KEY];
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

export const svalaFingerprintTransport: SupplierFingerprintTransport = {
  target: "svala",
  async configured() {
    return Boolean(await configuredToken());
  },
  async deliver(input) {
    const submission = parseSupplierFingerprintSubmission(input);
    const token = await configuredToken();
    if (!token) return { delivered: false, reason: "not_configured" };

    let response: Response;
    try {
      response = await fetch(SVALA_FINGERPRINT_ENDPOINT, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": submission.fingerprint.fingerprintId,
        },
        body: JSON.stringify(submission),
      });
    } catch {
      return { delivered: false, reason: "network" };
    }

    if (response.status === 200 || response.status === 201) {
      try {
        const result = parseReceiptResponse(await boundedText(response));
        if (result.receipt.fingerprintId !== submission.fingerprint.fingerprintId) throw new Error("Receipt fingerprint mismatch");
        return result;
      } catch {
        return { delivered: false, reason: "server" };
      }
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      return {
        delivered: false,
        reason: "rate_limited",
        ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: Math.min(seconds * 1_000, 24 * 60 * 60 * 1_000) } : {}),
      };
    }
    if (response.status >= 500) return { delivered: false, reason: "server" };
    return { delivered: false, reason: "rejected" };
  },
};

async function boundedText(response: Response): Promise<string> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("Svala receipt is too large");
  return text;
}

function parseReceiptResponse(text: string): { delivered: true; receipt: SvalaFingerprintReceipt; replayed: boolean } {
  const root: unknown = JSON.parse(text);
  if (!isExactRecord(root, ["receipt", "replayed"]) || typeof root.replayed !== "boolean") throw new Error("Invalid receipt envelope");
  const receipt = root.receipt;
  if (!isExactRecord(receipt, ["receiptId", "fingerprintId", "acceptedAt", "status"])) throw new Error("Invalid receipt");
  if (typeof receipt.receiptId !== "string" || !/^[0-9a-f-]{36}$/i.test(receipt.receiptId)) throw new Error("Invalid receipt ID");
  if (typeof receipt.fingerprintId !== "string" || !/^fp_[a-f0-9]{32}$/.test(receipt.fingerprintId)) throw new Error("Invalid fingerprint ID");
  if (typeof receipt.acceptedAt !== "string" || !Number.isFinite(Date.parse(receipt.acceptedAt))) throw new Error("Invalid receipt time");
  if (receipt.status !== "accepted") throw new Error("Invalid receipt status");
  return { delivered: true, receipt: receipt as unknown as SvalaFingerprintReceipt, replayed: root.replayed };
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).every((key) => keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
