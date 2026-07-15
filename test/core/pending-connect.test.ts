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
