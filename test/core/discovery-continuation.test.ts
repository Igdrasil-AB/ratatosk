import { describe, expect, it, vi } from "vitest";
import { canContinueSupplierDiscovery } from "../../collector/src/platform/discovery-continuation";

describe("supplier discovery continuation", () => {
  it("stops an active scan when its exact host permission has been revoked", async () => {
    const readStatus = vi.fn(async () => ({
      stage: "scanning" as const,
      runId: "run-1",
      tabId: 42,
      origin: "https://vendor.example",
      startedAt: 1,
    }));
    const hasPermission = vi.fn(async () => false);

    await expect(canContinueSupplierDiscovery("https://vendor.example", readStatus, hasPermission)).resolves.toBe(false);
    expect(hasPermission).toHaveBeenCalledWith("https://vendor.example");
  });

  it("does not query permissions after the scan was replaced", async () => {
    const readStatus = vi.fn(async () => ({ stage: "idle" as const }));
    const hasPermission = vi.fn(async () => true);

    await expect(canContinueSupplierDiscovery("https://vendor.example", readStatus, hasPermission)).resolves.toBe(false);
    expect(hasPermission).not.toHaveBeenCalled();
  });
});
