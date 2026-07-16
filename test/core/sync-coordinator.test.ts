import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAllConnected: vi.fn(),
  runVendorById: vi.fn(),
  claimScheduledWake: vi.fn(),
  completeScheduledWake: vi.fn(),
  ensureSyncAlarm: vi.fn(),
  getConnections: vi.fn(),
}));

vi.mock("../../collector/src/platform/collector", () => ({
  runAllConnected: mocks.runAllConnected,
  runVendorById: mocks.runVendorById,
}));
vi.mock("../../collector/src/platform/scheduler", () => ({
  claimScheduledWake: mocks.claimScheduledWake,
  completeScheduledWake: mocks.completeScheduledWake,
  ensureSyncAlarm: mocks.ensureSyncAlarm,
}));
vi.mock("../../collector/src/platform/storage", () => ({ getConnections: mocks.getConnections }));

import { requestSync } from "../../collector/src/platform/sync-coordinator";

const NOW = Date.parse("2026-07-17T08:00:00.000Z");
const CLAIM = { runId: "01234567-89ab-4def-8123-456789abcdef", fullSyncDue: true };

describe("Collector sync trigger coordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    mocks.completeScheduledWake.mockResolvedValue(undefined);
    mocks.ensureSyncAlarm.mockResolvedValue(undefined);
    mocks.runAllConnected.mockResolvedValue([]);
    mocks.runVendorById.mockImplementation(async (vendorId: string) => ({ vendorId, status: "ok", count: 0 }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("joins overlapping startup and alarm triggers", async () => {
    let resolveClaim!: (value: typeof CLAIM) => void;
    mocks.getConnections.mockResolvedValue({});
    mocks.claimScheduledWake.mockReturnValue(new Promise((resolve) => { resolveClaim = resolve; }));

    const startup = requestSync({ trigger: "startup" });
    const alarm = requestSync({ trigger: "alarm" });
    expect(alarm).toBe(startup);
    resolveClaim(CLAIM);

    await expect(startup).resolves.toEqual([]);
    expect(mocks.claimScheduledWake).toHaveBeenCalledTimes(1);
    expect(mocks.completeScheduledWake).toHaveBeenCalledWith(CLAIM, null);
  });

  it("runs a full sweep sequentially while leaving expired sessions paused", async () => {
    mocks.getConnections.mockResolvedValue({
      "vendor-a": { vendorId: "vendor-a", connectedAt: 1 },
      "vendor-b": { vendorId: "vendor-b", connectedAt: 1, lastStatus: "auth_expired" },
      "vendor-c": { vendorId: "vendor-c", connectedAt: 1 },
    });
    mocks.claimScheduledWake.mockResolvedValue(CLAIM);

    await expect(requestSync({ trigger: "alarm" })).resolves.toEqual([
      { vendorId: "vendor-a", status: "ok", count: 0 },
      { vendorId: "vendor-c", status: "ok", count: 0 },
    ]);
    expect(mocks.runVendorById).toHaveBeenNthCalledWith(1, "vendor-a", "scheduled");
    expect(mocks.runVendorById).toHaveBeenNthCalledWith(2, "vendor-c", "scheduled");
    expect(mocks.runVendorById.mock.invocationCallOrder[0]).toBeLessThan(mocks.runVendorById.mock.invocationCallOrder[1]);
  });

  it("runs only due retry vendors before the normal cadence", async () => {
    const nextRetryAt = NOW + 20 * 60_000;
    mocks.getConnections.mockResolvedValue({
      "vendor-due": { vendorId: "vendor-due", connectedAt: 1, nextEligibleRunAt: NOW - 1 },
      "vendor-later": { vendorId: "vendor-later", connectedAt: 1, nextEligibleRunAt: nextRetryAt },
      "vendor-normal": { vendorId: "vendor-normal", connectedAt: 1 },
    });
    mocks.claimScheduledWake.mockResolvedValue({ ...CLAIM, fullSyncDue: false });

    await requestSync({ trigger: "alarm" });

    expect(mocks.claimScheduledWake).toHaveBeenCalledWith({ retryDue: true, nextRetryAt, now: NOW });
    expect(mocks.runVendorById).toHaveBeenCalledOnce();
    expect(mocks.runVendorById).toHaveBeenCalledWith("vendor-due", "scheduled");
  });

  it("routes manual work through the same vendor join and reconciles retries", async () => {
    const nextRetryAt = NOW + 5 * 60_000;
    mocks.getConnections.mockResolvedValue({
      "vendor-a": { vendorId: "vendor-a", connectedAt: 1, nextEligibleRunAt: nextRetryAt },
    });

    await expect(requestSync({ trigger: "manual", vendorId: "vendor-a" })).resolves.toEqual([
      { vendorId: "vendor-a", status: "ok", count: 0 },
    ]);
    expect(mocks.runVendorById).toHaveBeenCalledWith("vendor-a", "manual");
    expect(mocks.ensureSyncAlarm).toHaveBeenCalledWith(nextRetryAt);
  });

  it("releases a persisted claim even if unexpected execution fails", async () => {
    mocks.getConnections.mockResolvedValue({ "vendor-a": { vendorId: "vendor-a", connectedAt: 1 } });
    mocks.claimScheduledWake.mockResolvedValue(CLAIM);
    mocks.runVendorById.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(requestSync({ trigger: "alarm" })).rejects.toThrow("storage unavailable");
    expect(mocks.completeScheduledWake).toHaveBeenCalledWith(CLAIM, null);
  });
});
