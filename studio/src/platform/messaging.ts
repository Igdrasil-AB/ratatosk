import type { DraftRecipe } from "../../../src/core/recorder/types";
import type { SupplierFingerprintSubmissionV1, SupplierFingerprintV1 } from "../../../src/core/recorder/supplier-fingerprint";

export type StudioMessage =
  | { type: "recorderStart" }
  | { type: "recorderStop" }
  | { type: "recorderStatus" }
  | { type: "recorderProgress" }
  | { type: "fingerprintApprove"; fingerprint: SupplierFingerprintV1; authorityConfirmed: boolean; shareApproved: boolean }
  | { type: "fingerprintOutboxStatus" }
  | { type: "fingerprintOutboxList" }
  | { type: "fingerprintOutboxGet"; fingerprintId: string }
  | { type: "fingerprintDeliver"; fingerprintId: string }
  | { type: "fingerprintPair"; token: string }
  | { type: "fingerprintDisconnect" }
  | { type: "missionLoad"; code: string }
  | { type: "missionStatus" }
  | { type: "missionClear" }
  | { type: "fingerprintClearOutbox" };

export interface RecorderProgress {
  recording: boolean;
  captured: number;
  documents: number;
  detected: boolean;
}

export interface RecorderStopResult {
  draft: DraftRecipe | null;
  captured: number;
  samples: string[];
  docLinks: string[];
  report: string;
  fingerprint: SupplierFingerprintV1 | null;
}

export interface FingerprintOutboxStatus {
  totalCount: number;
  pendingCount: number;
  deliveredCount: number;
  rejectedCount: number;
  oldestQueuedAt?: string;
  transport: { target: "svala"; configured: boolean };
}

export type FingerprintDeliveryState = "pending" | "delivering" | "delivered" | "retryable" | "rejected";

export interface FingerprintReceiptSummary {
  readonly receiptId: string;
  readonly acceptedAt: string;
  readonly status: "accepted";
}

export interface FingerprintOutboxItemSummary {
  readonly fingerprintId: string;
  readonly supplierId: string;
  readonly supplierOrigin: string;
  readonly capturedAt: string;
  readonly queuedAt: string;
  readonly expiresAt: string;
  readonly deliveryState: FingerprintDeliveryState;
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly receipt?: FingerprintReceiptSummary;
  readonly mission?: { readonly missionId: string; readonly status: string };
}

export type StudioResponse =
  | { ok: true }
  | { ok: true; recording: boolean }
  | { ok: true; progress: RecorderProgress }
  | { ok: true; submission: SupplierFingerprintSubmissionV1; outbox: FingerprintOutboxStatus }
  | { ok: true; items: readonly FingerprintOutboxItemSummary[] }
  | { ok: true; submission: SupplierFingerprintSubmissionV1 }
  | { ok: true; item: FingerprintOutboxItemSummary }
  | { ok: true; mission: import("./fingerprint-transport").SvalaCaptureMission | null }
  | { ok: true; outbox: FingerprintOutboxStatus }
  | ({ ok: true } & RecorderStopResult)
  | { ok: false; error: string };

export function send(message: StudioMessage): Promise<StudioResponse> {
  return chrome.runtime.sendMessage(message) as Promise<StudioResponse>;
}
