import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryPageObserverRegistration,
  disposeDiscoveryResources,
} from "../../collector/src/platform/discovery";

describe("supplier discovery cleanup", () => {
  it("always disposes the observer and preserves a primary discovery error", async () => {
    const primary = new Error("primary discovery failure");
    const explorerFailure = new Error("tab close failed");
    const observerFailure = new Error("observer unregister failed");
    const observer = { dispose: vi.fn(async () => { throw observerFailure; }) };
    const warn = vi.fn();

    const operation = (async () => {
      try {
        throw primary;
      } finally {
        await disposeDiscoveryResources([
          { dispose: async () => { throw explorerFailure; } },
          { dispose: async () => undefined },
        ], observer, [41], warn);
      }
    })();

    await expect(operation).rejects.toBe(primary);
    expect(observer.dispose).toHaveBeenCalledOnce();
    expect(observer.dispose).toHaveBeenCalledWith([41]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exploration-tab"), explorerFailure);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("discovery-observer"), observerFailure);
  });

  it("stops every frame in every adopted tab", async () => {
    const executeScript = vi.fn(async (_details: unknown) => []);
    vi.stubGlobal("chrome", {
      scripting: {
        executeScript,
        registerContentScripts: vi.fn(async () => undefined),
        unregisterContentScripts: vi.fn(async () => undefined),
      },
    });
    try {
      const observer = new DiscoveryPageObserverRegistration("https://vendor.example");
      await observer.start();
      await observer.adopt(41);
      await observer.dispose([41]);

      expect(executeScript.mock.calls.at(-1)?.[0]).toMatchObject({
        target: { tabId: 41, allFrames: true },
        world: "MAIN",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
