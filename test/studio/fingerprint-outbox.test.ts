import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveSupplierFingerprint, parseSupplierFingerprint } from "../../src/core/recorder/supplier-fingerprint";
import {
  clearFingerprintOutbox,
  enqueueFingerprintSubmission,
  fingerprintOutboxStatus,
  getFingerprintOutboxSubmission,
  listFingerprintOutboxItems,
} from "../../studio/src/platform/fingerprint-outbox";
import { svalaFingerprintTransport } from "../../studio/src/platform/fingerprint-transport";
import studioManifest from "../../studio/manifest.config";

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

  it("lists and revalidates retained submissions after the popup is reopened", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    const approved = submission(7);
    await enqueueFingerprintSubmission(approved, now);

    const [item] = await listFingerprintOutboxItems(new Date("2026-07-16T10:05:00.000Z"));
    expect(item).toEqual({
      fingerprintId: approved.fingerprint.fingerprintId,
      supplierId: "billing-example",
      supplierOrigin: "https://billing.example.com",
      capturedAt: "2026-07-16T10:00:00.000Z",
      queuedAt: "2026-07-16T10:00:00.000Z",
      expiresAt: "2026-08-15T10:00:00.000Z",
    });
    expect(Object.isFrozen(item)).toBe(true);
    expect(await getFingerprintOutboxSubmission(item.fingerprintId, new Date("2026-07-16T10:05:00.000Z"))).toEqual(approved);
    expect(await getFingerprintOutboxSubmission("fp_ffffffffffffffffffffffffffffffff", now)).toBeUndefined();
    expect(await getFingerprintOutboxSubmission("not-an-id", now)).toBeUndefined();
  });

  it("never lists or exports expired and corrupted submissions", async () => {
    const approved = submission(8);
    await enqueueFingerprintSubmission(approved, new Date("2026-06-01T00:00:00.000Z"));
    const afterExpiry = new Date("2026-07-16T00:00:00.000Z");
    expect(await listFingerprintOutboxItems(afterExpiry)).toEqual([]);
    expect(await getFingerprintOutboxSubmission(approved.fingerprint.fingerprintId, afterExpiry)).toBeUndefined();

    values["studio:supplier-fingerprint-outbox:v1"] = [{
      queuedAt: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-08-15T00:00:00.000Z",
      submission: { ...approved, unexpected: "must be rejected" },
    }];
    expect(await listFingerprintOutboxItems(new Date("2026-07-17T00:00:00.000Z"))).toEqual([]);
    expect(await getFingerprintOutboxSubmission(approved.fingerprint.fingerprintId)).toBeUndefined();
  });

  it("serializes concurrent enqueue and export operations", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    const approved = submission(9);
    const enqueue = enqueueFingerprintSubmission(approved, now);
    const exported = getFingerprintOutboxSubmission(approved.fingerprint.fingerprintId, now);

    await expect(enqueue).resolves.toMatchObject({ pendingCount: 1 });
    await expect(exported).resolves.toEqual(approved);
    await expect(listFingerprintOutboxItems(now)).resolves.toHaveLength(1);
  });

  it("cannot deliver or call the network while the Svala transport is unconfigured", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(svalaFingerprintTransport.configured).toBe(false);
    expect(await svalaFingerprintTransport.deliver(submission(1))).toEqual({ delivered: false, reason: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
    const manifest = studioManifest as unknown as Record<string, unknown>;
    expect(manifest.permissions).toEqual(["storage", "scripting", "debugger", "activeTab"]);
    expect("host_permissions" in manifest).toBe(false);
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
