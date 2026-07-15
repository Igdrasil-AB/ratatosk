import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHostPermissions } from "../../collector/src/platform/permissions";

describe("optional host permissions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts the Chrome request synchronously so callers retain the click gesture", async () => {
    let resolveRequest!: (granted: boolean) => void;
    const request = vi.fn(() => new Promise<boolean>((resolve) => { resolveRequest = resolve; }));
    vi.stubGlobal("chrome", { permissions: { request } });

    const pending = requestHostPermissions(["https://claude.ai/*"]);

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({ origins: ["https://claude.ai/*"] });
    resolveRequest(true);
    await expect(pending).resolves.toBe(true);
  });
});
