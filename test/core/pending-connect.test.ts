import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingConnect,
  getPendingConnect,
  setPendingConnect,
} from "../../collector/src/platform/pending-connect";

describe("pending vendor connection handoff", () => {
  const values: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: values[key] })),
          set: vi.fn(async (next: Record<string, unknown>) => Object.assign(values, next)),
          remove: vi.fn(async (key: string) => { delete values[key]; }),
        },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("survives the popup closing long enough for the service worker to finish", async () => {
    await setPendingConnect("anthropic", ["https://claude.ai/*"], 1_000);

    await expect(getPendingConnect(1_001)).resolves.toEqual({
      vendorId: "anthropic",
      origins: ["https://claude.ai/*"],
      startedAt: 1_000,
    });
  });

  it("rejects and clears stale handoffs", async () => {
    await setPendingConnect("anthropic", ["https://claude.ai/*"], 1_000);

    await expect(getPendingConnect(1_000 + 5 * 60_000 + 1)).resolves.toBeNull();
    expect(chrome.storage.session.remove).toHaveBeenCalledOnce();
  });

  it("does not let one vendor clear another vendor's handoff", async () => {
    const now = Date.now();
    await setPendingConnect("anthropic", ["https://claude.ai/*"], now);

    await clearPendingConnect("railway");
    await expect(getPendingConnect(now + 1)).resolves.toMatchObject({ vendorId: "anthropic" });
  });

  it("serializes a replacement handoff behind a vendor-scoped clear", async () => {
    const now = Date.now();
    await setPendingConnect("anthropic", ["https://claude.ai/*"], now);
    let releaseRead: (() => void) | undefined;
    const readBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
    (chrome.storage.session.get as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async (key: string) => {
      const snapshot = { [key]: structuredClone(values[key]) };
      await readBarrier;
      return snapshot;
    });

    const clearing = clearPendingConnect("anthropic");
    await vi.waitFor(() => expect(chrome.storage.session.get).toHaveBeenCalled());
    const replacing = setPendingConnect("railway", ["https://railway.com/*"], now + 1);
    releaseRead?.();
    await Promise.all([clearing, replacing]);

    await expect(getPendingConnect(now + 2)).resolves.toMatchObject({ vendorId: "railway" });
  });

  it("serializes a replacement handoff behind stale-record cleanup", async () => {
    await setPendingConnect("anthropic", ["https://claude.ai/*"], 1_000);
    let releaseRead: (() => void) | undefined;
    const readBarrier = new Promise<void>((resolve) => { releaseRead = resolve; });
    (chrome.storage.session.get as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async (key: string) => {
      const snapshot = { [key]: structuredClone(values[key]) };
      await readBarrier;
      return snapshot;
    });

    const expiring = getPendingConnect(1_000 + 5 * 60_000 + 1);
    await vi.waitFor(() => expect(chrome.storage.session.get).toHaveBeenCalled());
    const replacing = setPendingConnect("railway", ["https://railway.com/*"], 1_000 + 5 * 60_000 + 2);
    releaseRead?.();
    await expect(expiring).resolves.toBeNull();
    await replacing;

    await expect(getPendingConnect(1_000 + 5 * 60_000 + 3)).resolves.toMatchObject({ vendorId: "railway" });
  });

  it("rejects malformed or non-HTTPS handoffs from session storage", async () => {
    values.pendingVendorConnect = {
      vendorId: "anthropic",
      origins: ["http://claude.ai/*"],
      startedAt: Date.now(),
    };

    await expect(getPendingConnect()).resolves.toBeNull();
    expect(chrome.storage.session.remove).toHaveBeenCalledOnce();
  });
});
