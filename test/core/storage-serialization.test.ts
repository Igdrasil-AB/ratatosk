import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundedNextEligibleRunAt,
  getConnections,
  getNextEligibleRunAt,
  seenStore,
  upsertConnection,
} from "../../collector/src/platform/storage";

let values: Record<string, unknown>;

beforeEach(() => {
  values = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          await Promise.resolve();
          return { [key]: structuredClone(values[key]) };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          await Promise.resolve();
          Object.assign(values, structuredClone(items));
        }),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      },
    },
  });
});

describe("Collector storage mutation serialization", () => {
  it("retains interleaved seen keys from different vendors", async () => {
    const seen = seenStore();
    await Promise.all([
      seen.add("key-a", "ext:vendor-a"),
      seen.add("key-b", "ext:vendor-b"),
    ]);

    expect(values.seen).toEqual({ "key-a": "ext:vendor-a", "key-b": "ext:vendor-b" });
  });

  it("retains interleaved connection records", async () => {
    await Promise.all([
      upsertConnection({ vendorId: "vendor-a", connectedAt: 1 }),
      upsertConnection({ vendorId: "vendor-b", connectedAt: 2 }),
    ]);

    await expect(getConnections()).resolves.toEqual({
      "vendor-a": { vendorId: "vendor-a", connectedAt: 1 },
      "vendor-b": { vendorId: "vendor-b", connectedAt: 2 },
    });
  });

  it("persists bounded rate-limit eligibility and ignores expiry or corruption", async () => {
    const now = 1_000_000;
    const eligible = boundedNextEligibleRunAt(48 * 60 * 60 * 1_000, now);
    expect(eligible).toBe(now + 24 * 60 * 60 * 1_000);
    values.connections = {
      "vendor-a": { vendorId: "vendor-a", connectedAt: 1, nextEligibleRunAt: now + 60_000 },
      "vendor-b": { vendorId: "vendor-b", connectedAt: 1 },
    };
    await expect(getNextEligibleRunAt("vendor-a", now)).resolves.toBe(now + 60_000);
    await expect(getNextEligibleRunAt("vendor-b", now)).resolves.toBeNull();

    (values.connections as any)["vendor-a"].nextEligibleRunAt = now - 1;
    await expect(getNextEligibleRunAt("vendor-a", now)).resolves.toBeNull();
    expect((values.connections as any)["vendor-a"].nextEligibleRunAt).toBeUndefined();

    (values.connections as any)["vendor-a"].nextEligibleRunAt = Number.NaN;
    await expect(getNextEligibleRunAt("vendor-a", now)).resolves.toBeNull();
  });
});
