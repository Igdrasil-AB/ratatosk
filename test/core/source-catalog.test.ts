import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnections: vi.fn(),
  getDiscoveredSuppliers: vi.fn(),
}));

vi.mock("../../collector/src/platform/storage", () => ({
  getConnections: mocks.getConnections,
}));

vi.mock("../../collector/src/platform/discovered-suppliers", () => ({
  getDiscoveredSupplier: vi.fn(),
  getDiscoveredSuppliers: mocks.getDiscoveredSuppliers,
}));

import { listCollectorSources } from "../../collector/src/platform/source-catalog";

describe("Collector source catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConnections.mockResolvedValue({});
    mocks.getDiscoveredSuppliers.mockResolvedValue({});
  });

  it("does not advertise Railway before the user has connected it", async () => {
    await expect(listCollectorSources()).resolves.toEqual([]);
  });

  it("retains an explicitly connected bundled supplier for legacy users", async () => {
    mocks.getConnections.mockResolvedValue({
      railway: {
        vendorId: "railway",
        connectedAt: 1,
      },
    });

    await expect(listCollectorSources()).resolves.toEqual([
      expect.objectContaining({
        kind: "official",
        recipe: expect.objectContaining({ id: "railway" }),
      }),
    ]);
  });
});
