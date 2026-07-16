import { beforeEach, describe, expect, it, vi } from "vitest";
import { approveSupplierFingerprint, parseSupplierFingerprint } from "../../src/core/recorder/supplier-fingerprint";
import {
  clearFingerprintOutbox,
  deliverFingerprintSubmission,
  enqueueFingerprintSubmission,
  fingerprintOutboxStatus,
  getFingerprintOutboxSubmission,
  listFingerprintOutboxItems,
  requeueRejectedFingerprintSubmissions,
} from "../../studio/src/platform/fingerprint-outbox";
import {
  disconnectSvalaFingerprintTransport,
  pairSvalaFingerprintTransport,
  SVALA_FINGERPRINT_ENDPOINT,
  svalaFingerprintTransport,
} from "../../studio/src/platform/fingerprint-transport";
import studioManifest from "../../studio/manifest.config";

const values: Record<string, unknown> = {};
const INTAKE_TOKEN = `rtk_${"A".repeat(43)}`;
const RECEIPT_ID = "11111111-2222-4333-8444-555555555555";

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
  it("deduplicates, caps retained approvals, and starts with delivery unpaired", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    for (let index = 0; index < 21; index += 1) {
      await enqueueFingerprintSubmission(submission(index), new Date(now.getTime() + index));
    }
    await enqueueFingerprintSubmission(submission(20), new Date(now.getTime() + 100));

    expect(await fingerprintOutboxStatus(now)).toEqual({
      totalCount: 20,
      pendingCount: 20,
      deliveredCount: 0,
      rejectedCount: 0,
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
      deliveryState: "pending",
      attempts: 0,
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

  it("cannot deliver or call the network while the Svala transport is unpaired", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(await svalaFingerprintTransport.configured()).toBe(false);
    expect(await svalaFingerprintTransport.deliver(submission(1))).toEqual({ delivered: false, reason: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
    const manifest = studioManifest as unknown as Record<string, unknown>;
    expect(manifest.permissions).toEqual(["storage", "scripting", "debugger", "activeTab"]);
    expect(manifest.host_permissions).toEqual(["https://svala.igdrasil.se/*"]);
  });

  it("sends a scoped token only to the fixed HTTPS endpoint and rejects redirect failures", async () => {
    await pairSvalaFingerprintTransport(INTAKE_TOKEN);
    const approved = submission(2);
    const fetch = vi.fn(async () => receiptResponse(approved.fingerprint.fingerprintId));
    vi.stubGlobal("fetch", fetch);

    await expect(svalaFingerprintTransport.deliver(approved)).resolves.toMatchObject({ delivered: true, replayed: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SVALA_FINGERPRINT_ENDPOINT);
    expect(url).toBe("https://svala.igdrasil.se/api/dev/ratatosk/fingerprints");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${INTAKE_TOKEN}`, "Idempotency-Key": approved.fingerprint.fingerprintId });

    fetch.mockRejectedValueOnce(new TypeError("redirect disallowed"));
    await expect(svalaFingerprintTransport.deliver(approved)).resolves.toEqual({ delivered: false, reason: "network" });
    await disconnectSvalaFingerprintTransport();
  });

  it("single-flights delivery, retains a stable receipt, and never removes manual export", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    const approved = submission(3);
    await enqueueFingerprintSubmission(approved, now);
    await pairSvalaFingerprintTransport(INTAKE_TOKEN);
    const fetch = vi.fn(async () => receiptResponse(approved.fingerprint.fingerprintId));
    vi.stubGlobal("fetch", fetch);

    const [first, second] = await Promise.all([
      deliverFingerprintSubmission(approved.fingerprint.fingerprintId, now),
      deliverFingerprintSubmission(approved.fingerprint.fingerprintId, now),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ deliveryState: "delivered", attempts: 1, receipt: { receiptId: RECEIPT_ID } });
    expect(await listFingerprintOutboxItems(new Date("2026-07-16T10:05:00.000Z"))).toEqual([first]);
    expect(await getFingerprintOutboxSubmission(approved.fingerprint.fingerprintId, now)).toEqual(approved);
  });

  it("backs off retryable failures and resumes an interrupted delivery once", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    const approved = submission(4);
    await enqueueFingerprintSubmission(approved, now);
    await pairSvalaFingerprintTransport(INTAKE_TOKEN);
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(receiptResponse(approved.fingerprint.fingerprintId));
    vi.stubGlobal("fetch", fetch);

    await expect(deliverFingerprintSubmission(approved.fingerprint.fingerprintId, now)).resolves.toMatchObject({
      deliveryState: "retryable",
      attempts: 1,
      nextAttemptAt: "2026-07-16T10:01:00.000Z",
    });
    await deliverFingerprintSubmission(approved.fingerprint.fingerprintId, new Date("2026-07-16T10:00:59.000Z"));
    expect(fetch).toHaveBeenCalledTimes(1);

    const stored = values["studio:supplier-fingerprint-outbox:v1"] as Array<Record<string, unknown>>;
    stored[0] = { ...stored[0], deliveryState: "delivering", nextAttemptAt: undefined };
    const [recovered] = await listFingerprintOutboxItems(new Date("2026-07-16T10:01:00.000Z"));
    expect(recovered).toMatchObject({ deliveryState: "retryable", attempts: 1, nextAttemptAt: "2026-07-16T10:01:00.000Z" });
    await expect(deliverFingerprintSubmission(approved.fingerprint.fingerprintId, new Date("2026-07-16T10:01:00.000Z"))).resolves.toMatchObject({ deliveryState: "delivered", attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected 4xx until an explicit re-pair or review reset", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    const approved = submission(5);
    await enqueueFingerprintSubmission(approved, now);
    await pairSvalaFingerprintTransport(INTAKE_TOKEN);
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetch);

    await expect(deliverFingerprintSubmission(approved.fingerprint.fingerprintId, now)).resolves.toMatchObject({ deliveryState: "rejected", attempts: 1 });
    await deliverFingerprintSubmission(approved.fingerprint.fingerprintId, new Date("2026-07-17T10:00:00.000Z"));
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(requeueRejectedFingerprintSubmissions(now)).resolves.toMatchObject({ pendingCount: 1, rejectedCount: 0 });
  });

  it("scopes a mission code to delivery and retains the mission receipt state", async () => {
    const now = new Date("2026-07-16T10:00:00.000Z");
    const approved = submission(6);
    const missionCode = `rmc_${"B".repeat(43)}`;
    await enqueueFingerprintSubmission(approved, now, missionCode);
    await pairSvalaFingerprintTransport(INTAKE_TOKEN);
    const fetch = vi.fn(async () => receiptResponse(approved.fingerprint.fingerprintId, true));
    vi.stubGlobal("fetch", fetch);
    const delivered = await deliverFingerprintSubmission(approved.fingerprint.fingerprintId, now);
    expect(delivered).toMatchObject({
      deliveryState: "delivered",
      mission: { missionId: "ratmission_0123456789abcdef0123456789abcdef", status: "accepted_for_review" },
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ "X-Ratatosk-Mission-Code": missionCode });
    expect(await getFingerprintOutboxSubmission(approved.fingerprint.fingerprintId, now)).toEqual(approved);
  });
});

function receiptResponse(fingerprintId: string, includeMission = false): Response {
  return new Response(JSON.stringify({
    receipt: { receiptId: RECEIPT_ID, fingerprintId, acceptedAt: "2026-07-16T10:02:00.000Z", status: "accepted" },
    replayed: false,
    ...(includeMission ? { mission: { missionId: "ratmission_0123456789abcdef0123456789abcdef", status: "accepted_for_review" } } : {}),
  }), { status: 201, headers: { "content-type": "application/json" } });
}

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
