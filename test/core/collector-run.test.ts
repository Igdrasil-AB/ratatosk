import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimited } from "../../src/core/errors";

const mocks = vi.hoisted(() => ({
  runVendor: vi.fn(),
  getVendor: vi.fn(),
  getSinkConfig: vi.fn(),
  buildRunContext: vi.fn(),
  buildStrategies: vi.fn(() => ({})),
  buildSink: vi.fn(),
  recordCollected: vi.fn(async () => undefined),
  recordRun: vi.fn(async () => undefined),
  notifyReconnect: vi.fn(),
  getNextEligibleRunAt: vi.fn(),
  boundedNextEligibleRunAt: vi.fn(() => 1_800_000),
}));

vi.mock("../../src/core/engine", () => ({ runVendor: mocks.runVendor }));
vi.mock("../../src/vendors", () => ({ getVendor: mocks.getVendor }));
vi.mock("../../collector/src/platform/runtime", () => ({
  buildRunContext: mocks.buildRunContext,
  buildStrategies: mocks.buildStrategies,
  buildSink: mocks.buildSink,
}));
vi.mock("../../collector/src/platform/storage", () => ({
  getConnections: vi.fn(async () => ({})),
  getSinkConfig: mocks.getSinkConfig,
  recordCollected: mocks.recordCollected,
  recordRun: mocks.recordRun,
  sinkCompanyId: vi.fn(() => "company"),
  getNextEligibleRunAt: mocks.getNextEligibleRunAt,
  boundedNextEligibleRunAt: mocks.boundedNextEligibleRunAt,
}));
vi.mock("../../collector/src/platform/notifications", () => ({ notifyReconnect: mocks.notifyReconnect }));

import { runVendorById } from "../../collector/src/platform/collector";

describe("Collector per-vendor run coordinator", () => {
  const seenAdd = vi.fn(async () => undefined);
  const sinkSend = vi.fn(async () => ({ accepted: true }));
  const dispose = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVendor.mockImplementation((id: string) => ({ id, name: id }));
    mocks.getSinkConfig.mockResolvedValue({ kind: "filesystem", rootFolder: "Invoices", dateMode: "invoice" });
    mocks.getNextEligibleRunAt.mockResolvedValue(null);
    mocks.buildRunContext.mockReturnValue({ ctx: { seen: { add: seenAdd } }, dispose });
    mocks.buildSink.mockResolvedValue({ send: sinkSend });
  });

  it("joins overlapping triggers and marks seen only after the sink accepts", async () => {
    let resolveRun!: (value: unknown) => void;
    mocks.runVendor.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));

    const first = runVendorById("vendor-a");
    const second = runVendorById("vendor-a");
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.runVendor).toHaveBeenCalledTimes(1));

    resolveRun({ documents: [document("vendor-a")], scopes: scopes() });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { vendorId: "vendor-a", status: "ok", count: 1, failedScopes: 0, emptyScopes: 0 },
      { vendorId: "vendor-a", status: "ok", count: 1, failedScopes: 0, emptyScopes: 0 },
    ]);
    expect(sinkSend).toHaveBeenCalledTimes(1);
    expect(seenAdd).toHaveBeenCalledTimes(1);
    expect(sinkSend.mock.invocationCallOrder[0]).toBeLessThan(seenAdd.mock.invocationCallOrder[0]);
  });

  it("does not mark a rejected sink result seen", async () => {
    mocks.runVendor.mockResolvedValue({ documents: [document("vendor-b")], scopes: scopes() });
    sinkSend.mockResolvedValueOnce({ accepted: false });

    await expect(runVendorById("vendor-b")).resolves.toMatchObject({ status: "error", code: "destination_unavailable" });
    expect(seenAdd).not.toHaveBeenCalled();
  });

  it("records partial scope truth and stable rate-limit eligibility", async () => {
    mocks.runVendor.mockResolvedValueOnce({
      documents: [document("vendor-c")],
      scopes: scopes({ total: 2, succeeded: 1, failed: 1, failureCodes: ["recipe_incompatible"] }),
    });
    await expect(runVendorById("vendor-c")).resolves.toMatchObject({
      status: "partial",
      code: "partial_scope_failure",
      failedScopes: 1,
    });
    expect(mocks.recordRun).toHaveBeenCalledWith("vendor-c", expect.objectContaining({ lastStatus: "partial", lastFailedScopes: 1 }));

    mocks.runVendor.mockRejectedValueOnce(new RateLimited(120_000, "vendor-d"));
    await expect(runVendorById("vendor-d")).resolves.toEqual({
      vendorId: "vendor-d",
      status: "rate_limited",
      count: 0,
      code: "rate_limited",
      nextEligibleRunAt: 1_800_000,
    });
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
    expect(mocks.runVendor).not.toHaveBeenCalled();
    expect(mocks.buildSink).not.toHaveBeenCalled();
  });
});

function document(vendorId: string) {
  return {
    idempotencyKey: `key-${vendorId}`,
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
