import { afterEach, describe, expect, it, vi } from "vitest";
import { configureSidePanelAction } from "../../collector/src/platform/side-panel";

describe("persistent collector side panel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the global side panel when the toolbar action is clicked", async () => {
    const setPanelBehavior = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", { sidePanel: { setPanelBehavior } });

    await expect(configureSidePanelAction()).resolves.toBe(true);
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
  });

  it("fails safely when the browser cannot configure the surface", async () => {
    vi.stubGlobal("chrome", {
      sidePanel: { setPanelBehavior: vi.fn().mockRejectedValue(new Error("unavailable")) },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(configureSidePanelAction()).resolves.toBe(false);
  });
});
