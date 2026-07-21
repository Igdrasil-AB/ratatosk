import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundedNextEligibleRunAt,
  getConnections,
  getNextEligibleRunAt,
  removeConnection,
  clearSeenForSource,
  recordRun,
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

    expect(values.seen).toEqual({
      "key-a": { source: "ext:vendor-a", acceptedAt: expect.any(Number) },
      "key-b": { source: "ext:vendor-b", acceptedAt: expect.any(Number) },
    });
  });

  it("atomically reserves one concurrent claimant and releases only reservations", async () => {
    const seen = seenStore();
    const claims = await Promise.all([
      seen.claimIfAbsent("shared-key", "ext:vendor-a"),
      seen.claimIfAbsent("shared-key", "ext:vendor-a"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(seen.has("shared-key")).resolves.toBe(true);
    await expect(seen.isAccepted?.("shared-key")).resolves.toBe(false);

    await seen.release("shared-key", claims.find(Boolean)!);
    await expect(seen.has("shared-key")).resolves.toBe(false);
    const replacement = await seen.claimIfAbsent("shared-key", "ext:vendor-a");
    expect(replacement).toBeTypeOf("string");
    await seen.add("shared-key", "ext:vendor-a");
    await seen.release("shared-key", replacement!);
    await expect(seen.has("shared-key")).resolves.toBe(true);
    await expect(seen.isAccepted?.("shared-key")).resolves.toBe(true);
  });

  it("clears only explicitly attributed vendor history and preserves legacy entries", async () => {
    values.seen = {
      "key-a": { source: "ext:vendor-a", acceptedAt: 1 },
      "key-b": "ext:vendor-b",
      legacy: 123,
    };
    await clearSeenForSource("ext:vendor-a");
    expect(values.seen).toEqual({ "key-b": "ext:vendor-b", legacy: 123 });
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

  it("tracks attempts, complete coverage, and new deliveries independently", async () => {
    await upsertConnection({ vendorId: "vendor-a", connectedAt: 1 });
    await recordRun("vendor-a", { lastStatus: "ok", lastCount: 2 });
    const completed = (await getConnections())["vendor-a"];
    expect(completed.lastAttemptAt).toBeTypeOf("number");
    expect(completed.lastCompleteSyncAt).toBe(completed.lastAttemptAt);
    expect(completed.lastNewInvoiceAt).toBe(completed.lastAttemptAt);

    await recordRun("vendor-a", { lastStatus: "error", lastCount: 0 });
    const failed = (await getConnections())["vendor-a"];
    expect(failed.lastAttemptAt).toBeGreaterThanOrEqual(completed.lastAttemptAt!);
    expect(failed.lastCompleteSyncAt).toBe(completed.lastCompleteSyncAt);
    expect(failed.lastNewInvoiceAt).toBe(completed.lastNewInvoiceAt);
  });

  it("does not recreate a disconnected vendor when a stale run finishes", async () => {
    await upsertConnection({ vendorId: "vendor-disconnected", connectedAt: 1 });
    await removeConnection("vendor-disconnected");
    await recordRun("vendor-disconnected", { lastStatus: "ok", lastCount: 1 });

    expect((await getConnections())["vendor-disconnected"]).toBeUndefined();
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
