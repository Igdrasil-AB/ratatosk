import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveSupplierFingerprint, parseSupplierFingerprint } from "../../src/core/recorder/supplier-fingerprint";
import {
  clearFingerprintOutbox,
  enqueueFingerprintSubmission,
  fingerprintOutboxStatus,
} from "../../studio/src/platform/fingerprint-outbox";

const values: Record<string, unknown> = {};

beforeEach(() => {
  for (const key of Object.keys(values)) delete values[key];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      },
    },
  });
});

describe("Studio supplier fingerprint outbox", () => {
  it("deduplicates, caps retained approvals, and exposes no configured transport", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    for (let index = 0; index < 21; index += 1) {
      await enqueueFingerprintSubmission(submission(index), new Date(now.getTime() + index));
    }
    await enqueueFingerprintSubmission(submission(20), new Date(now.getTime() + 100));

    expect(await fingerprintOutboxStatus(now)).toEqual({
      pendingCount: 20,
      oldestQueuedAt: "2026-07-16T10:00:00.001Z",
      transport: { target: "svala", configured: false },
    });
  });

  it("prunes expired or malformed local state and can be explicitly cleared", async () => {
    await enqueueFingerprintSubmission(submission(1), new Date("2026-06-01T00:00:00.000Z"));
    expect((await fingerprintOutboxStatus(new Date("2026-07-16T00:00:00.000Z"))).pendingCount).toBe(0);

    values["studio:supplier-fingerprint-outbox:v1"] = [{ queuedAt: "today", expiresAt: "later", submission: { rawCapture: "secret" } }];
    expect((await fingerprintOutboxStatus()).pendingCount).toBe(0);
    expect((await clearFingerprintOutbox()).pendingCount).toBe(0);
  });
});

function submission(index: number) {
  const fingerprintId = `fp_${index.toString(16).padStart(32, "0")}`;
  const fingerprint = parseSupplierFingerprint({
    schema: "ratatosk.supplier-fingerprint.v1",
    fingerprintId,
    capturedAt: "2026-07-16T10:00:00.000Z",
    studioVersion: "0.7.0",
    supplier: { origin: "https://billing.example.com", idCandidate: "billing-example" },
    evidence: {
      requestCount: 0,
      structuredResponseCount: 0,
      documentCount: 0,
      confidence: "none",
      requests: [],
      inferred: null,
    },
    privacy: {
      structuralOnly: true,
      rawBodiesIncluded: false,
      requestHeadersIncluded: false,
      fixtureIncluded: false,
      queryValuesIncluded: false,
      invoiceValuesIncluded: false,
    },
  });
  return approveSupplierFingerprint({
    fingerprint,
    approvedAt: "2026-07-16T10:01:00.000Z",
    authorityConfirmed: true,
    shareApproved: true,
  });
}
