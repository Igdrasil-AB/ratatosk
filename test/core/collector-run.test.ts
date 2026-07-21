import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthExpired, DocumentPermissionRequired, RateLimited } from "../../src/core/errors";
import type { IngestResult } from "../../src/ingest/sink";

const mocks = vi.hoisted(() => ({
  streamVendor: vi.fn(),
  resolveCollectorSource: vi.fn(),
  getSinkConfig: vi.fn(),
  buildRunContext: vi.fn(),
  buildStrategies: vi.fn(() => ({})),
  buildSink: vi.fn(),
  recordCollected: vi.fn(async () => undefined),
  recordRun: vi.fn(async () => undefined),
  notifyReconnect: vi.fn(),
  getNextEligibleRunAt: vi.fn(),
  boundedNextEligibleRunAt: vi.fn(() => 1_800_000),
  getConnections: vi.fn(async () => ({})),
}));

vi.mock("../../src/core/engine", () => ({ streamVendor: mocks.streamVendor }));
vi.mock("../../collector/src/platform/source-catalog", () => ({ resolveCollectorSource: mocks.resolveCollectorSource }));
vi.mock("../../collector/src/platform/runtime", () => ({
  buildRunContext: mocks.buildRunContext,
  buildStrategies: mocks.buildStrategies,
  buildSink: mocks.buildSink,
}));
vi.mock("../../collector/src/platform/storage", () => ({
  getConnections: mocks.getConnections,
  getSinkConfig: mocks.getSinkConfig,
  recordCollected: mocks.recordCollected,
  recordRun: mocks.recordRun,
  sinkCompanyId: vi.fn(() => "company"),
  getNextEligibleRunAt: mocks.getNextEligibleRunAt,
  boundedNextEligibleRunAt: mocks.boundedNextEligibleRunAt,
}));
vi.mock("../../collector/src/platform/notifications", () => ({ notifyReconnect: mocks.notifyReconnect }));

import { runDiscoveredCandidate, runVendorById } from "../../collector/src/platform/collector";

describe("Collector per-vendor run coordinator", () => {
  const seenAdd = vi.fn(async () => undefined);
  const sinkSend = vi.fn(async (): Promise<IngestResult> => ({ accepted: true }));
  const dispose = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCollectorSource.mockImplementation(async (id: string) => ({
      kind: "official",
      recipe: { id, name: id },
      primaryOrigin: "https://example.test",
    }));
    mocks.getSinkConfig.mockResolvedValue({ kind: "filesystem", rootFolder: "Invoices", dateMode: "invoice" });
    mocks.getNextEligibleRunAt.mockResolvedValue(null);
    mocks.getConnections.mockResolvedValue({});
    mocks.buildRunContext.mockReturnValue({ ctx: { seen: { add: seenAdd } }, dispose });
    mocks.buildSink.mockResolvedValue({ send: sinkSend });
  });

  it("joins overlapping triggers and marks seen only after the sink accepts", async () => {
    let releaseRun!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRun = resolve; });
    mocks.streamVendor.mockImplementation(async (_recipe, _ctx, _strategies, emit) => {
      await gate;
      await emit(document("vendor-a"));
      return { vendorId: "vendor-a", documentCount: 1, scopes: scopes() };
    });

    const first = runVendorById("vendor-a");
    const second = runVendorById("vendor-a");
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.streamVendor).toHaveBeenCalledTimes(1));

    releaseRun();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ vendorId: "vendor-a", status: "ok", count: 1, verifiedCount: 1, failedScopes: 0, emptyScopes: 0 }),
      expect.objectContaining({ vendorId: "vendor-a", status: "ok", count: 1, verifiedCount: 1, failedScopes: 0, emptyScopes: 0 }),
    ]);
    expect(sinkSend).toHaveBeenCalledTimes(1);
    expect(seenAdd).toHaveBeenCalledTimes(2);
    expect(sinkSend.mock.invocationCallOrder[0]).toBeLessThan(seenAdd.mock.invocationCallOrder[0]);
  });

  it("uses the same destination snapshot for the run context and sink", async () => {
    const config = { kind: "filesystem" as const, rootFolder: "Invoices", dateMode: "invoice" as const };
    mocks.getSinkConfig.mockResolvedValue(config);
    mocks.streamVendor.mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
      await emit(document("vendor-destination-snapshot"));
      return { vendorId: "vendor-destination-snapshot", documentCount: 1, scopes: scopes() };
    });

    await runVendorById("vendor-destination-snapshot");

    expect(mocks.buildSink).toHaveBeenCalledWith(config);
  });

  it("does not mark a rejected sink result seen", async () => {
    mocks.streamVendor.mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
      await emit(document("vendor-b"));
      return { vendorId: "vendor-b", documentCount: 1, scopes: scopes() };
    });
    sinkSend.mockResolvedValueOnce({ accepted: false });

    await expect(runVendorById("vendor-b")).resolves.toMatchObject({ status: "error", code: "destination_unavailable" });
    expect(seenAdd).not.toHaveBeenCalled();
  });

  it("records backend duplicates in local history without reporting a new collection", async () => {
    mocks.streamVendor.mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
      await emit(document("vendor-deduped"));
      return { vendorId: "vendor-deduped", documentCount: 1, scopes: scopes() };
    });
    sinkSend.mockResolvedValueOnce({ accepted: true, deduped: true });

    await expect(runVendorById("vendor-deduped")).resolves.toMatchObject({
      status: "ok",
      count: 0,
      verifiedCount: 1,
    });
    expect(seenAdd).toHaveBeenCalledTimes(2);
    expect(mocks.recordCollected).toHaveBeenCalledWith([
      expect.objectContaining({ key: "key-vendor-deduped" }),
    ]);
  });

  it("retries durable ledger history before marking a backend-deduplicated retry seen", async () => {
    mocks.streamVendor
      .mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
        await emit(document("vendor-ledger-retry"));
        return { vendorId: "vendor-ledger-retry", documentCount: 1, scopes: scopes() };
      })
      .mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
        await emit(document("vendor-ledger-retry"));
        return { vendorId: "vendor-ledger-retry", documentCount: 1, scopes: scopes() };
      });
    sinkSend
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: true, deduped: true });
    mocks.recordCollected
      .mockRejectedValueOnce(new Error("ledger unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(runVendorById("vendor-ledger-retry")).resolves.toMatchObject({
      status: "partial",
      count: 1,
      code: "destination_unavailable",
    });
    expect(seenAdd).not.toHaveBeenCalled();

    // `runVendorById` intentionally joins overlapping triggers; yield until
    // the settled run has released its per-vendor coordination slot.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(runVendorById("vendor-ledger-retry")).resolves.toMatchObject({
      status: "ok",
      count: 0,
      verifiedCount: 1,
    });
    expect(mocks.recordCollected).toHaveBeenCalledTimes(2);
    expect(mocks.recordCollected.mock.invocationCallOrder[1]).toBeLessThan(seenAdd.mock.invocationCallOrder[0]);
    expect(seenAdd).toHaveBeenCalledTimes(2);
  });

  it("leaves the primary retry guard unset when the content dedup write fails", async () => {
    mocks.streamVendor.mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
      await emit(document("vendor-secondary-seen"));
      return { vendorId: "vendor-secondary-seen", documentCount: 1, scopes: scopes() };
    });
    seenAdd.mockRejectedValueOnce(new Error("content seen unavailable"));

    await expect(runVendorById("vendor-secondary-seen")).resolves.toMatchObject({
      status: "partial",
      count: 1,
      code: "destination_unavailable",
    });
    expect(mocks.recordCollected).toHaveBeenCalledWith([
      expect.objectContaining({ key: "key-vendor-secondary-seen" }),
    ]);
    expect(seenAdd).toHaveBeenCalledOnce();
    expect(seenAdd).toHaveBeenCalledWith("content-vendor-secondary-seen", "ext:vendor-secondary-seen");
  });

  it("writes the primary retry guard last so its failure remains recoverable", async () => {
    mocks.streamVendor.mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
      await emit(document("vendor-primary-seen"));
      return { vendorId: "vendor-primary-seen", documentCount: 1, scopes: scopes() };
    });
    seenAdd.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("primary seen unavailable"));

    await expect(runVendorById("vendor-primary-seen")).resolves.toMatchObject({
      status: "partial",
      count: 1,
      code: "destination_unavailable",
    });
    expect(seenAdd.mock.calls).toEqual([
      ["content-vendor-primary-seen", "ext:vendor-primary-seen"],
      ["key-vendor-primary-seen", "ext:vendor-primary-seen"],
    ]);
  });

  it("admits a discovered profile only after the first PDF reaches the destination", async () => {
    const order: string[] = [];
    mocks.streamVendor.mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
      await emit(document("discovered-vendor"));
      return { vendorId: "discovered-vendor", documentCount: 1, scopes: scopes() };
    });
    sinkSend.mockImplementationOnce(async () => {
      order.push("sink");
      return { accepted: true };
    });

    await runDiscoveredCandidate({ id: "discovered-vendor", name: "Discovered" } as never, async () => {
      order.push("admit");
    });

    expect(order).toEqual(["sink", "admit"]);
  });

  it("durably records an accepted delivery but fails discovery when admission persistence fails", async () => {
    const order: string[] = [];
    mocks.streamVendor.mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
      await emit(document("discovered-durable"));
      return { vendorId: "discovered-durable", documentCount: 1, scopes: scopes() };
    });
    sinkSend.mockImplementationOnce(async () => {
      order.push("sink");
      return { accepted: true };
    });
    seenAdd.mockImplementationOnce(async () => { order.push("seen"); });
    mocks.recordCollected.mockImplementationOnce(async () => { order.push("ledger"); });

    await expect(runDiscoveredCandidate(
      { id: "discovered-durable", name: "Discovered" } as never,
      async () => {
        order.push("admit");
        throw new Error("storage unavailable");
      },
    )).resolves.toMatchObject({
      vendorId: "discovered-durable",
      status: "error",
      count: 1,
      verifiedCount: 0,
      code: "connection_persistence_failed",
    });

    expect(order).toEqual(["sink", "ledger", "admit"]);
    expect(seenAdd).not.toHaveBeenCalled();
    expect(mocks.recordRun).not.toHaveBeenCalled();
  });

  it("records partial scope truth and stable rate-limit eligibility", async () => {
    mocks.streamVendor.mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
      await emit(document("vendor-c"));
      return {
        vendorId: "vendor-c",
        documentCount: 1,
        scopes: scopes({ total: 2, succeeded: 1, failed: 1, failureCodes: ["recipe_incompatible"] }),
      };
    });
    await expect(runVendorById("vendor-c")).resolves.toMatchObject({
      status: "partial",
      code: "partial_scope_failure",
      failedScopes: 1,
    });
    expect(mocks.recordRun).toHaveBeenCalledWith("vendor-c", expect.objectContaining({ lastStatus: "partial", lastFailedScopes: 1 }));

    mocks.streamVendor.mockRejectedValueOnce(new RateLimited(120_000, "vendor-d"));
    await expect(runVendorById("vendor-d")).resolves.toEqual({
      vendorId: "vendor-d",
      status: "rate_limited",
      count: 0,
      code: "rate_limited",
      nextEligibleRunAt: 1_800_000,
    });
  });

  it("reports a committed document when a later fetch fails fatally", async () => {
    mocks.streamVendor.mockImplementationOnce(async (_recipe, _ctx, _strategies, emit) => {
      await emit(document("vendor-f"));
      throw new AuthExpired("vendor-f");
    });

    await expect(runVendorById("vendor-f")).resolves.toMatchObject({
      vendorId: "vendor-f",
      status: "partial",
      count: 1,
      code: "auth_expired",
    });
    expect(mocks.recordRun).toHaveBeenCalledWith("vendor-f", expect.objectContaining({
      lastStatus: "partial",
      lastCount: 1,
      lastCode: "auth_expired",
    }));
  });

  it("persists only the exact provider origin when Stripe moves a document", async () => {
    mocks.getConnections.mockResolvedValueOnce({
      "vendor-stripe": { vendorId: "vendor-stripe", connectedAt: 1 },
    });
    mocks.streamVendor.mockRejectedValueOnce(new DocumentPermissionRequired("stripe", [
      "https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*",
    ], "vendor-stripe"));

    await expect(runVendorById("vendor-stripe")).resolves.toMatchObject({
      status: "error",
      code: "document_permission_required",
      requiredOrigins: ["https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*"],
    });
    expect(mocks.recordRun).toHaveBeenCalledWith("vendor-stripe", expect.objectContaining({
      documentOrigins: ["https://stripe-upload-api.s3.eu-north-1.amazonaws.com/*"],
    }));
  });

  it("skips a premature retry without touching the supplier", async () => {
    mocks.getNextEligibleRunAt.mockResolvedValueOnce(2_000_000);
    await expect(runVendorById("vendor-e")).resolves.toEqual({
      vendorId: "vendor-e",
      status: "skipped",
      count: 0,
      code: "rate_limited",
      nextEligibleRunAt: 2_000_000,
    });
    expect(mocks.streamVendor).not.toHaveBeenCalled();
    expect(mocks.buildSink).not.toHaveBeenCalled();
  });
});

function document(vendorId: string) {
  return {
    idempotencyKey: `key-${vendorId}`,
    contentIdempotencyKey: `content-${vendorId}`,
    source: `ext:${vendorId}`,
    vendorId,
    vendorName: vendorId,
    vendorInvoiceId: "invoice-1",
    issuedAt: "2026-07-16",
    filename: "invoice.pdf",
    contentType: "application/pdf",
    bytes: new TextEncoder().encode("%PDF").buffer,
  };
}

function scopes(overrides: Partial<{ total: number; succeeded: number; empty: number; failed: number; failureCodes: string[] }> = {}) {
  return { total: 1, succeeded: 1, empty: 0, failed: 0, failureCodes: [], ...overrides };
}
