import type { DraftRecipe } from "../../../src/core/recorder/types";
import type { SupplierFingerprintSubmissionV1, SupplierFingerprintV1 } from "../../../src/core/recorder/supplier-fingerprint";

export type StudioMessage =
  | { type: "recorderStart" }
  | { type: "recorderStop" }
  | { type: "recorderStatus" }
  | { type: "recorderProgress" }
  | { type: "fingerprintApprove"; fingerprint: SupplierFingerprintV1; authorityConfirmed: boolean; shareApproved: boolean }
  | { type: "fingerprintOutboxStatus" }
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
  pendingCount: number;
  oldestQueuedAt?: string;
  transport: { target: "svala"; configured: false };
}

export type StudioResponse =
  | { ok: true }
  | { ok: true; recording: boolean }
  | { ok: true; progress: RecorderProgress }
  | { ok: true; submission: SupplierFingerprintSubmissionV1; outbox: FingerprintOutboxStatus }
  | { ok: true; outbox: FingerprintOutboxStatus }
  | ({ ok: true } & RecorderStopResult)
  | { ok: false; error: string };

export function send(message: StudioMessage): Promise<StudioResponse> {
  return chrome.runtime.sendMessage(message) as Promise<StudioResponse>;
}
